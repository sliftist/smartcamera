import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { pathToFileURL } from "url";
import { formatDateTime } from "socket-function/src/formatting/format";
import { encodeJpeg } from "./src/jpeg";
import { redactUrl, StreamTarget } from "./src/credentials";
import { RtspClient } from "./src/rtsp";
import { AccessUnit, H264Depacketizer, isKeyframe, nalType, parseParameterSets, parseSps, toAnnexB, NAL_TYPE_PPS, NAL_TYPE_SPS } from "./src/h264";
import { decodeKeyframe, initializeDecoder, DecodedFrame } from "./src/decoder";
import { StreamDecoder } from "./src/streamDecoder";
import { resizeToFit, rotate180 } from "./src/overlay";
import { AskBackend, createAskBackend } from "./src/askBackend";
import { loadViews, View } from "./src/views";

const PORT = 8770;
const HOST = "127.0.0.1";
const VIDEO_CHANNEL = 0;
const RECONNECT_DELAY_MS = 5 * 1000;
const KEYFRAME_TIMEOUT_MS = 30 * 1000;
/** Past this, a frame the running decoder produced is stale and the next one is waited for instead. */
const INSTANT_MAX_AGE_MS = 1000;
/**
 * How long the decoder keeps running after the last request finishes. Tearing it down the instant
 * demand hits zero means the next request has to wait for a keyframe to seed the decoder again, which
 * turns instant mode back into keyframe mode for any caller that pauses between questions.
 */
const IDLE_GRACE_MS = 5 * 1000;
/**
 * Access units held while a decode is in flight before we give up and rejoin at a keyframe.
 *
 * Generous on purpose. Encoding a jpeg blocks this loop for tens of milliseconds and the stream is
 * tcp, so a stall does not lose packets, it delivers them in a burst afterwards. At 16 a couple of
 * those bursts a second was enough to throw the queue away roughly once per keyframe, and every one
 * of those is a visible tear. The decoder catches up at about 80 frames a second once it is let run,
 * so four seconds of backlog drains in well under one. Latency is bounded by the caller anyway, which
 * refuses a frame older than INSTANT_MAX_AGE_MS.
 */
const MAX_QUEUED_UNITS = 60;
/** The last this many analysed frames are kept on disk, clobbering the oldest, named just by number. */
const KEPT_FRAMES = 100;
const FRAME_DIRECTORY = path.join(__dirname, "frames");
const KNOWN_FLAGS = new Set(["instant", "debug"]);
const INDEX_PATTERN = /^\d+$/;
const MAX_PROMPT_LENGTH = 2000;
/**
 * What /frame hands out. Matching what the model is actually shown means a caller keeping frames for
 * review is looking at the same pixels the answer came from, and a full size jpeg costs about twice
 * as long to encode for detail that was never in front of the model.
 */
const SERVED_FRAME_WIDTH = 1280;
const SERVED_FRAME_HEIGHT = 704;
const LOCAL_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

type CapturedImage = {
    image: DecodedFrame;
    capturedAtMs: number;
    decodeMs: number;
    /** True when it came from the running decoder rather than from waiting for a fresh keyframe. */
    instant: boolean;
};

type Request = {
    prompt: string;
    resolve: (result: Record<string, unknown>) => void;
    reject: (error: Error) => void;
};

/**
 * Holds an rtsp session open and produces images on demand.
 *
 * Idle, nothing is kept or decoded: a frame nobody is waiting for is dropped where it is found. Under
 * demand in instant mode the decoder runs continuously, so an image is ready the moment it is asked
 * for instead of after the wait for the next keyframe.
 */
class ViewWatcher {
    private waiters: ((captured: CapturedImage) => void)[] = [];
    private seen = 0;
    private used = 0;
    private demand = 0;
    private decoder: StreamDecoder | undefined;
    private busy = false;
    private needKeyframe = true;
    private newest: CapturedImage | undefined;
    private resyncs = 0;
    private lastDemandAtMs = 0;
    private queue: { annexB: Buffer; width: number; height: number; key: boolean }[] = [];

    constructor(private view: View, private instant: boolean) { }

    get name(): string {
        return this.view.name;
    }

    get seenCount(): number {
        return this.seen;
    }

    get usedCount(): number {
        return this.used;
    }

    get waiting(): number {
        return this.waiters.length;
    }

    get resyncCount(): number {
        return this.resyncs;
    }

    get streaming(): boolean {
        return this.decoder !== undefined;
    }

    /** Held for as long as a caller might ask, so the decoder keeps running between its questions. */
    addDemand() {
        this.demand++;
        this.lastDemandAtMs = Date.now();
    }

    removeDemand() {
        this.demand = Math.max(0, this.demand - 1);
        this.lastDemandAtMs = Date.now();
    }

    private get inDemand(): boolean {
        return this.waiters.length > 0 || this.demand > 0 || Date.now() - this.lastDemandAtMs < IDLE_GRACE_MS;
    }

    /**
     * The freshest image available. In instant mode that is whatever the running decoder produced last,
     * and otherwise the next keyframe off the wire, decoded on its own.
     */
    nextImage(): Promise<CapturedImage> {
        const ready = this.newest;
        // A stalled stream must not hand back the last thing it managed to decode forever.
        if (this.instant && ready && Date.now() - ready.capturedAtMs <= INSTANT_MAX_AGE_MS) {
            return Promise.resolve(ready);
        }
        return new Promise(resolve => this.waiters.push(resolve));
    }

    /** Never stores anything by itself: only the streaming path keeps a frame, and only while it runs. */
    private resolveAll(captured: CapturedImage) {
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) {
            waiter(captured);
        }
    }

    private stopDecoding() {
        this.decoder?.close();
        this.decoder = undefined;
        this.needKeyframe = true;
        this.newest = undefined;
    }

    /** Keyframe only mode: each one stands alone, so it is decoded and the decoder forgets it again. */
    private async decodeOnce(annexB: Buffer, width: number, height: number) {
        const startedAtMs = Date.now();
        try {
            const image = await decodeKeyframe(annexB, width, height);
            if (this.view.upsideDown) {
                rotate180(image);
            }
            this.resolveAll({ image, capturedAtMs: startedAtMs, decodeMs: Date.now() - startedAtMs, instant: false });
        } catch (error) {
            log(`${this.view.name}: could not decode a keyframe: ${(error as Error).message}`);
        }
    }

    /** Drains the queue one access unit at a time, in order, which is the only order they decode in. */
    private async drain() {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            while (this.queue.length > 0) {
                const next = this.queue.shift();
                if (!next) {
                    break;
                }
                if (this.needKeyframe && !next.key) {
                    continue;
                }
                await this.decodeStreaming(next.annexB, next.width, next.height, next.key);
            }
        } finally {
            this.busy = false;
        }
    }

    private async decodeStreaming(annexB: Buffer, width: number, height: number, key: boolean) {
        const startedAtMs = Date.now();
        try {
            if (!this.decoder) {
                if (!key) {
                    return;
                }
                const decoder = new StreamDecoder();
                await decoder.start();
                this.decoder = decoder;
            }
            const frames = await this.decoder.decode(annexB, width, height);
            this.needKeyframe = false;
            this.used++;
            const image = frames[frames.length - 1];
            if (!image) {
                return;
            }
            if (this.view.upsideDown) {
                rotate180(image);
            }
            const captured = { image, capturedAtMs: startedAtMs, decodeMs: Date.now() - startedAtMs, instant: true };
            this.newest = captured;
            this.resolveAll(captured);
        } catch (error) {
            log(`${this.view.name}: decode failed, waiting for the next keyframe: ${(error as Error).message}`);
            this.stopDecoding();
            this.resyncs++;
        }
    }

    async run() {
        while (true) {
            try {
                await this.session();
            } catch (error) {
                log(`${this.view.name}: stream ended, reconnecting in ${RECONNECT_DELAY_MS / 1000}s: ${(error as Error).message}`);
            }
            await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
        }
    }

    private async session() {
        const client = new RtspClient(this.view.target);
        await client.connect();
        const tracks = await client.describe();
        const video = tracks.find(track => track.kind === "video");
        if (!video) {
            throw new Error(`The stream has no video track`);
        }
        if (video.encoding !== "H264") {
            throw new Error(`Expected an H264 video track, got ${video.encoding}`);
        }

        let sps: Buffer | undefined;
        let pps: Buffer | undefined;
        for (const parameterSet of parseParameterSets(video.fmtp.get("sprop-parameter-sets"))) {
            if (nalType(parameterSet) === NAL_TYPE_SPS) {
                sps = parameterSet;
            } else if (nalType(parameterSet) === NAL_TYPE_PPS) {
                pps = parameterSet;
            }
        }

        const depacketizer = new H264Depacketizer((unit: AccessUnit) => {
            for (const nal of unit.nals) {
                if (nalType(nal) === NAL_TYPE_SPS) {
                    sps = nal;
                } else if (nalType(nal) === NAL_TYPE_PPS) {
                    pps = nal;
                }
            }
            const key = isKeyframe(unit);
            if (key) {
                this.seen++;
            }
            const currentSps = sps;
            const currentPps = pps;
            if (!currentSps || !currentPps) {
                return;
            }
            if (!this.instant) {
                // Nobody is asking, so this frame is dropped here: no copy, no decode, no memory.
                if (!key || this.waiters.length === 0) {
                    return;
                }
                const slices = unit.nals.filter(nal => nalType(nal) !== NAL_TYPE_SPS && nalType(nal) !== NAL_TYPE_PPS);
                const { width, height } = parseSps(currentSps);
                const annexB = toAnnexB([currentSps, currentPps, ...slices]);
                this.used++;
                void this.decodeOnce(annexB, width, height);
                return;
            }

            // Instant mode. With nothing to answer we fall back to just watching the keyframes go by.
            if (!this.inDemand) {
                if (this.decoder) {
                    this.stopDecoding();
                }
                return;
            }
            // A P frame is only meaningful on top of the state its keyframe built, so the stream is
            // always joined at a keyframe and rejoined at one after anything is missed.
            if (this.needKeyframe && !key) {
                return;
            }
            const nals = key ? [currentSps, currentPps, ...unit.nals.filter(nal => nalType(nal) !== NAL_TYPE_SPS && nalType(nal) !== NAL_TYPE_PPS)] : unit.nals;
            const { width, height } = parseSps(currentSps);
            // Interleaved rtsp is tcp, so a burst after something blocked the loop is late rather than
            // lost. Queueing keeps the decoder's state intact; only being persistently behind resyncs.
            this.queue.push({ annexB: toAnnexB(nals), width, height, key });
            if (this.queue.length > MAX_QUEUED_UNITS) {
                this.queue.length = 0;
                this.needKeyframe = true;
                // The dropped units are the reference frames everything after them was predicted from,
                // so the decoder is holding state that no longer describes the stream. Waiting for a
                // keyframe is not enough on its own: unless that state is thrown away, the next frames
                // decode against it and come out as smeared blocks over anything that moved.
                this.decoder?.reset();
                this.resyncs++;
                return;
            }
            void this.drain();
        });

        client.onRtpPacket = packet => {
            if (packet.channel !== VIDEO_CHANNEL) {
                return;
            }
            depacketizer.push(packet);
        };

        await client.setupInterleaved(video, VIDEO_CHANNEL);
        await client.play();
        log(`${this.view.name}: watching ${redactUrl(this.view.target.url)}${this.view.upsideDown ? " (upside down)" : ""}`);
        try {
            await client.connectionLost();
        } finally {
            await client.close();
        }
    }
}

class Server {
    private watchers: ViewWatcher[] = [];
    private pending = new Map<number, Request[]>();
    private working = false;
    private frameNumber = 0;

    constructor(private views: View[], private client: AskBackend, private instant: boolean, private debug: boolean) {
        this.watchers = views.map(view => new ViewWatcher(view, instant));
    }

    start() {
        for (const watcher of this.watchers) {
            void watcher.run();
        }
    }

    ask(index: number, prompt: string): Promise<Record<string, unknown>> {
        // Demand is held for the whole request, so instant mode keeps decoding while we think.
        this.watchers[index].addDemand();
        const finished = new Promise<Record<string, unknown>>((resolve, reject) => {
            const queue = this.pending.get(index) ?? [];
            queue.push({ prompt, resolve, reject });
            this.pending.set(index, queue);
            void this.pump();
        });
        return finished.finally(() => this.watchers[index].removeDemand());
    }

    /** One image is decoded per round, then every question waiting on that view is asked about it. */
    private async pump() {
        if (this.working) {
            return;
        }
        this.working = true;
        try {
            while (true) {
                const index = [...this.pending.keys()].find(key => (this.pending.get(key)?.length ?? 0) > 0);
                if (index === undefined) {
                    return;
                }
                await this.runBatch(index);
            }
        } finally {
            this.working = false;
        }
    }

    private async runBatch(index: number) {
        const watcher = this.watchers[index];
        const view = this.views[index];
        let batch: Request[] = [];
        try {
            const timeout = new Promise<never>((_, fail) =>
                setTimeout(() => fail(new Error(`No frame from ${view.name} within ${KEYFRAME_TIMEOUT_MS / 1000}s`)), KEYFRAME_TIMEOUT_MS));
            const captured = await Promise.race([watcher.nextImage(), timeout]);

            // Drained only once the frame is in hand, so everything asked up to this moment shares it.
            batch = this.pending.get(index) ?? [];
            this.pending.set(index, []);
            if (batch.length === 0) {
                return;
            }
            const image = captured.image;
            const frameFile = this.debug ? path.join(FRAME_DIRECTORY, `${this.frameNumber % KEPT_FRAMES}.jpg`) : undefined;
            if (frameFile) {
                this.frameNumber++;
            }

            // Blank line first, so each frame and its answers read as their own block.
            console.log("");
            log(`${view.name}  ${captured.instant ? "frame" : "keyframe"} ${formatDateTime(captured.capturedAtMs)}`
                + `  ${image.width}x${image.height}  decoded in ${captured.decodeMs}ms`
                + `  ${batch.length} prompt${batch.length === 1 ? "" : "s"}`);
            if (frameFile) {
                console.log(`    ${pathToFileURL(frameFile).href}`);
            }

            for (let position = 0; position < batch.length; position++) {
                const request = batch[position];
                const label = `[${position + 1}/${batch.length}]`;
                try {
                    const result = await this.client.ask(image, request.prompt);
                    console.log(`    ${label} ${JSON.stringify(request.prompt)}`);
                    console.log(`    ${" ".repeat(label.length)} -> ${result.answer || "(empty)"}`);
                    // Not every backend can separate encoding the image from prefilling the prompt,
                    // and one that cannot reports no vision time rather than a made up split.
                    console.log(`    ${" ".repeat(label.length)}    ${result.modelMs.toFixed(0)}ms`
                        + (result.visionMs > 0 ? ` = vision ${result.visionMs.toFixed(0)} +` : ` =`)
                        + ` prefill ${result.prefillMs.toFixed(0)} (${result.promptTokens} tok)`
                        + ` + generate ${result.generateMs.toFixed(0)} (${result.outputTokens} tok)`);
                    request.resolve({
                        index,
                        view: view.name,
                        prompt: request.prompt,
                        answer: result.answer,
                        // Only in debug, where a frame is kept at all. A caller that wants to see what
                        // an answer was actually looking at has no other way to find it, since the
                        // number cycles and the next frame will take the name back.
                        frameFile,
                        frameAt: new Date(captured.capturedAtMs).toISOString(),
                        instant: captured.instant,
                        decodeMs: captured.decodeMs,
                        visionMs: result.visionMs,
                        prefillMs: result.prefillMs,
                        generateMs: result.generateMs,
                        analyzeMs: result.modelMs,
                        promptTokens: result.promptTokens,
                        outputTokens: result.outputTokens,
                    });
                } catch (error) {
                    console.log(`    ${label} ${JSON.stringify(request.prompt)}`);
                    console.log(`    ${" ".repeat(label.length)} -> failed: ${(error as Error).message}`);
                    request.reject(error as Error);
                }
            }

            // Written only once every answer is out. Encoding a jpeg blocks the loop for about 100ms,
            // which would otherwise be charged to the caller's reply and to reading the stream.
            if (frameFile) {
                await this.saveFrame(image, frameFile);
            }
        } catch (error) {
            for (const request of batch) {
                request.reject(error as Error);
            }
        }
    }

    private async saveFrame(image: DecodedFrame, file: string) {
        try {
            await fs.promises.mkdir(FRAME_DIRECTORY, { recursive: true });
            // Saved at the size the model was shown rather than full resolution. Encoding 1920x1080
            // blocks this loop for about 176ms against about 76ms for the smaller one, and that stall
            // is charged to reading the stream. Detail the model never saw is not worth a tear, and a
            // debug frame that matches what it was actually looking at is the more useful one anyway.
            const scaled = resizeToFit(image, SERVED_FRAME_WIDTH, SERVED_FRAME_HEIGHT);
            await fs.promises.writeFile(file, encodeJpeg(scaled.rgb, scaled.width, scaled.height));
        } catch (error) {
            log(`could not write ${file}: ${(error as Error).message}`);
        }
    }

    /**
     * The freshest frame, as a jpeg. Demand is held across the wait so instant mode keeps decoding
     * for a caller that only wants pictures, which is what stops this from returning the same frame
     * over and over once the decoder has idled out.
     */
    async frame(index: number): Promise<Buffer> {
        const watcher = this.watchers[index];
        watcher.addDemand();
        try {
            const timeout = new Promise<never>((_, fail) =>
                setTimeout(() => fail(new Error(`No frame from ${this.views[index].name} within ${KEYFRAME_TIMEOUT_MS / 1000}s`)), KEYFRAME_TIMEOUT_MS));
            const captured = await Promise.race([watcher.nextImage(), timeout]);
            const scaled = resizeToFit(captured.image, SERVED_FRAME_WIDTH, SERVED_FRAME_HEIGHT);
            return encodeJpeg(scaled.rgb, scaled.width, scaled.height);
        } finally {
            watcher.removeDemand();
        }
    }

    status(): Record<string, unknown> {
        return {
            views: this.views.map(view => ({
                index: view.index,
                name: view.name,
                upsideDown: view.upsideDown,
                keyframesSeen: this.watchers[view.index].seenCount,
                framesDecoded: this.watchers[view.index].usedCount,
                waiting: this.watchers[view.index].waiting,
                streaming: this.watchers[view.index].streaming,
                resyncs: this.watchers[view.index].resyncCount,
            })),
            instant: this.instant,
            debug: this.debug,
        };
    }
}

function readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.on("data", chunk => {
            body += chunk;
            if (body.length > MAX_PROMPT_LENGTH * 4) {
                reject(new Error(`The request body is too large`));
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

async function readParameters(request: http.IncomingMessage, url: URL): Promise<Record<string, string>> {
    const parameters: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
        parameters[key] = value;
    }
    if (request.method === "POST") {
        const body = await readBody(request);
        if (body.trim()) {
            try {
                Object.assign(parameters, JSON.parse(body));
            } catch {
                throw new Error(`The request body is not valid json`);
            }
        }
    }
    return parameters;
}

async function main() {
    // Whatever dies, it dies saying why. The crash this exists for printed nothing but the wrapper's
    // own rethrow, which is what an unhandled stream error event looks like.
    process.on("uncaughtException", error => {
        console.error(`[eye2] uncaught exception (carrying on):`, (error as Error).stack ?? error);
    });
    process.on("unhandledRejection", reason => {
        console.error(`[eye2] unhandled rejection (carrying on):`, (reason as Error)?.stack ?? reason);
    });
    process.on("exit", code => {
        console.error(`[eye2] process exiting with code ${code}`);
    });

    // Order never matters and neither does a leading dash, so "eye2 debug instant" reads the same as
    // "eye2 --instant --debug". A misspelled flag is refused rather than quietly doing nothing.
    const flags = new Set(process.argv.slice(2).map(argument => argument.replace(/^--?/, "").toLowerCase()));
    const unknown = [...flags].filter(flag => !KNOWN_FLAGS.has(flag));
    if (unknown.length > 0) {
        console.error(`[eye2] unrecognised argument${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")};`
            + ` known flags are ${[...KNOWN_FLAGS].join(", ")}`);
        process.exit(1);
    }
    const instant = flags.has("instant");
    const debug = flags.has("debug");
    const views = await loadViews();
    if (views.length === 0) {
        throw new Error(`Found no view batch files to watch`);
    }

    const { backend: client, name: backendName } = createAskBackend(__dirname, message => log(message));
    console.log(`[eye2] starting Qwen3-VL on the ${backendName} backend, this takes a moment while the weights load`);
    // Deliberately not awaited. A model that will not start is a reason to answer questions with an
    // error, not a reason for this process to die: the camera half works without it, /frame and
    // /status keep serving, and the backend retries on its own. Waiting here made one bad model flag
    // into a crash loop that took the whole service down 82 times before anyone looked.
    void client.start()
        .then(imageTokens => console.log(`[eye2] model ready, ${imageTokens} image tokens per frame`))
        .catch(error => log(`the model did not come up: ${(error as Error).message}; it will keep trying`));
    await initializeDecoder();
    console.log(instant
        ? `[eye2] instant: every frame is decoded while anything is asking, idling on keyframes otherwise`
        : `[eye2] keyframes only, pass "instant" to decode every frame while anything is asking`);
    console.log(debug
        ? `[eye2] debug: the last ${KEPT_FRAMES} analysed frames are kept in ${FRAME_DIRECTORY}`
        : `[eye2] pass "debug" to keep the last ${KEPT_FRAMES} analysed frames on disk`);
    for (const view of views) {
        console.log(`[eye2]   index ${view.index} = ${view.name}${view.upsideDown ? " (upside down)" : ""}`);
    }

    const server = new Server(views, client, instant, debug);
    server.start();

    const http_server = http.createServer((request, response) => {
        void (async () => {
            const send = (status: number, payload: Record<string, unknown>) => {
                const text = JSON.stringify(payload);
                response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
                response.end(text);
            };
            // Nothing here is authenticated, so nothing outside this machine may reach it.
            const remote = request.socket.remoteAddress ?? "";
            if (!LOCAL_ADDRESSES.has(remote)) {
                log(`refused a request from ${remote}`);
                send(403, { error: "Only localhost may ask" });
                return;
            }
            try {
                const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
                if (url.pathname === "/status") {
                    send(200, server.status());
                    return;
                }
                if (url.pathname === "/frame") {
                    const rawFrameIndex = url.searchParams.get("index") ?? "0";
                    if (!INDEX_PATTERN.test(rawFrameIndex) || Number(rawFrameIndex) >= views.length) {
                        send(400, { error: `index must be a whole number below ${views.length}` });
                        return;
                    }
                    const jpeg = await server.frame(Number(rawFrameIndex));
                    response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": jpeg.length });
                    response.end(jpeg);
                    return;
                }
                const parameters = await readParameters(request, url);
                const rawIndex = String(parameters.index ?? "");
                // A number and only a number: the index picks a camera, it never names a file.
                if (!INDEX_PATTERN.test(rawIndex)) {
                    send(400, { error: `index must be a whole number, got ${JSON.stringify(rawIndex)}` });
                    return;
                }
                const index = Number(rawIndex);
                if (index >= views.length) {
                    send(400, { error: `index must be below ${views.length}, got ${index}` });
                    return;
                }
                const prompt = String(parameters.prompt ?? "").trim();
                if (!prompt) {
                    send(400, { error: `prompt is required` });
                    return;
                }
                if (prompt.length > MAX_PROMPT_LENGTH) {
                    send(400, { error: `prompt must be at most ${MAX_PROMPT_LENGTH} characters` });
                    return;
                }
                send(200, await server.ask(index, prompt));
            } catch (error) {
                send(500, { error: (error as Error).message });
            }
        })();
    });

    http_server.listen(PORT, HOST, () => {
        console.log(`[eye2] listening on http://${HOST}:${PORT} (localhost only)`);
        console.log(`[eye2]   GET /?index=0&prompt=is%20a%20person%20in%20the%20image`);
        console.log(`[eye2]   POST / {"index":0,"prompt":"..."}`);
        console.log(`[eye2]   GET /status`);
        console.log(`[eye2]   GET /frame?index=0  the freshest frame as a jpeg`);
    });
}

main().catch(error => {
    console.error(`[eye2] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
