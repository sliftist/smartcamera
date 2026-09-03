import * as path from "path";
import * as readline from "readline";
import { formatDateTime } from "socket-function/src/formatting/format";
import { fileExists, readStreamTarget, redactUrl, StreamTarget } from "./src/credentials";
import { RtspClient } from "./src/rtsp";
import { AccessUnit, H264Depacketizer, isKeyframe, nalType, parseParameterSets, parseSps, toAnnexB, NAL_TYPE_PPS, NAL_TYPE_SPS } from "./src/h264";
import { decodeKeyframe, initializeDecoder } from "./src/decoder";
import { cropImage, rotate180, CropRegion } from "./src/overlay";
import { RgbImage } from "./src/yolo";
import { AskClient } from "./src/askClient";

const VIDEO_CHANNEL = 0;
const RECONNECT_DELAY_MS = 5 * 1000;
const DEFAULT_PROMPT = "is a person in the image, yes or no, no explanation or preamble";
const PROMPT_LABEL = "ask> ";
const UPSIDE_DOWN_WORDS = ["upsidedown", "upside-down"];
const CROP_PATTERN = /^crop-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;
const MAX_PERCENT = 100;

function printHelp() {
    console.log(`
Watches an RTSP camera and asks Qwen3-VL a question about every keyframe.

  yarn ask <credentials file> [upsidedown] [crop-<x0>-<x1>-<y0>-<y1>] [help]

The credentials file is the same one "yarn smart" takes (a VLC .bat launcher works).

The question being asked is always shown on the bottom line, ready to edit. Type a different one and
press enter and every frame from then on is asked that instead. Nothing is written to disk.
`.trim());
}

type Arguments = {
    credentialsFile: string;
    upsideDown: boolean;
    crop: CropRegion | undefined;
};

function parseCrop(word: string): CropRegion | undefined {
    const match = CROP_PATTERN.exec(word);
    if (!match) {
        return undefined;
    }
    const [xStart, xEnd, yStart, yEnd] = match.slice(1).map(value => parseFloat(value));
    for (const value of [xStart, xEnd, yStart, yEnd]) {
        if (value < 0 || value > MAX_PERCENT) {
            throw new Error(`Crop percentages must be between 0 and ${MAX_PERCENT}, got ${word}`);
        }
    }
    if (xStart >= xEnd || yStart >= yEnd) {
        throw new Error(`Crop needs its start below its end on both axes, got x ${xStart} to ${xEnd} and y ${yStart} to ${yEnd}`);
    }
    return { xStart, xEnd, yStart, yEnd };
}

async function parseArguments(argv: string[]): Promise<Arguments | undefined> {
    let credentialsFile = "";
    let upsideDown = false;
    let crop: CropRegion | undefined;

    for (const raw of argv) {
        const argument = raw.replace(/^--?/, "");
        if (argument === "help") {
            return undefined;
        }
        if (UPSIDE_DOWN_WORDS.includes(argument)) {
            upsideDown = true;
            continue;
        }
        const parsedCrop = parseCrop(argument);
        if (parsedCrop) {
            crop = parsedCrop;
            continue;
        }
        if (await fileExists(raw)) {
            credentialsFile = raw;
            continue;
        }
        console.error(`Unrecognised argument ${JSON.stringify(raw)}: it is not a known word and not a file that exists.\n`);
        return undefined;
    }

    if (!credentialsFile) {
        return undefined;
    }
    return { credentialsFile, upsideDown, crop };
}

/** Keeps the question pinned to the bottom line while answers scroll above it. */
class Console {
    private rl: readline.Interface | undefined;
    private prompt = DEFAULT_PROMPT;
    private originalLog = console.log.bind(console);

    constructor() {
        // Without a terminal there is nothing to edit, so the question stays as it started and the
        // answers are just printed. That is what happens when the output is piped to a file.
        if (!process.stdin.isTTY) {
            this.originalLog(`[ask] stdin is not a terminal, so the question stays "${this.prompt}"`);
            return;
        }
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        this.rl.setPrompt(PROMPT_LABEL);
        this.rl.on("line", line => {
            const text = line.trim();
            if (text && text !== this.prompt) {
                this.prompt = text;
                this.log(`asking "${text}" from now on`);
            }
            this.show();
        });
        this.rl.on("close", () => process.exit(0));
        this.show();
    }

    get current(): string {
        return this.prompt;
    }

    /** Writes above the question line, then puts it back exactly as the user left it. */
    log(message: string) {
        this.write(`${formatDateTime(Date.now())} | ${message}`);
    }

    /**
     * rtsp.ts and decoder.ts print straight to console.log, which would otherwise land on top of the
     * question line and leave it half drawn. Everything goes through the same redraw instead.
     */
    captureConsole() {
        const forward = (...args: unknown[]) => this.write(args.map(argument => String(argument)).join(" "));
        console.log = forward;
        console.error = forward;
    }

    private write(text: string) {
        if (!this.rl) {
            this.originalLog(text);
            return;
        }
        readline.cursorTo(process.stdout, 0);
        readline.clearLine(process.stdout, 0);
        process.stdout.write(`${text}\n`);
        this.rl.prompt(true);
    }

    private show() {
        this.rl?.prompt();
        this.rl?.write(this.prompt);
    }
}

async function runSession(target: StreamTarget, onKeyframe: (getImage: () => Promise<RgbImage>) => void) {
    const client = new RtspClient(target);
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
        if (!isKeyframe(unit)) {
            return;
        }
        const currentSps = sps;
        const currentPps = pps;
        if (!currentSps || !currentPps) {
            return;
        }
        const slices = unit.nals.filter(nal => nalType(nal) !== NAL_TYPE_SPS && nalType(nal) !== NAL_TYPE_PPS);
        const annexB = toAnnexB([currentSps, currentPps, ...slices]);
        const { width, height } = parseSps(currentSps);
        onKeyframe(() => decodeKeyframe(annexB, width, height));
    });

    client.onRtpPacket = packet => {
        if (packet.channel !== VIDEO_CHANNEL) {
            return;
        }
        depacketizer.push(packet);
    };

    await client.setupInterleaved(video, VIDEO_CHANNEL);
    await client.play();
    try {
        await client.connectionLost();
    } finally {
        await client.close();
    }
}

async function main() {
    const parsed = await parseArguments(process.argv.slice(2));
    if (!parsed) {
        printHelp();
        process.exit(0);
    }

    const target = await readStreamTarget(parsed.credentialsFile);
    const repoRoot = __dirname;

    console.log(`[ask] ${redactUrl(target.url)}${parsed.upsideDown ? ", rotating the image 180 degrees" : ""}`);
    console.log(`[ask] starting Qwen3-VL, this takes a moment while the engines load`);

    let terminal: Console | undefined;
    const client = new AskClient(repoRoot, message => {
        if (terminal) {
            terminal.log(message);
        } else {
            console.log(message);
        }
    });
    const imageTokens = await client.start();
    await initializeDecoder();
    console.log(`[ask] ready, ${imageTokens} image tokens per frame`);
    console.log(`[ask] type a different question at the bottom and press enter to change it`);

    terminal = new Console();
    terminal.captureConsole();

    let skipped = 0;
    const onKeyframe = (getImage: () => Promise<RgbImage>) => {
        if (client.busy) {
            skipped++;
            return;
        }
        const question = terminal!.current;
        const droppedBefore = skipped;
        skipped = 0;
        void (async () => {
            try {
                // Timing starts here, once the keyframe is in hand: nothing below waits on the camera.
                const startedAtMs = Date.now();
                const decoded = await getImage();
                if (parsed.upsideDown) {
                    rotate180(decoded);
                }
                const image = parsed.crop ? cropImage(decoded, parsed.crop) : decoded;
                const h264Ms = Date.now() - startedAtMs;

                const result = await client.ask(image, question);
                const handoffMs = Math.max(0, result.roundTripMs - result.modelMs);
                const totalMs = h264Ms + result.roundTripMs;
                const dropped = droppedBefore > 0 ? `, skipped ${droppedBefore}` : "";
                terminal!.log(
                    `${result.answer || "(empty)"}`
                    + `   [${totalMs.toFixed(0)}ms total`
                    + ` = h264 ${h264Ms.toFixed(0)}`
                    + ` + vision ${result.visionMs.toFixed(0)}`
                    + ` + prefill ${result.prefillMs.toFixed(0)} (${result.promptTokens} tok)`
                    + ` + generate ${result.generateMs.toFixed(0)} (${result.outputTokens} tok`
                    + `, ${(result.outputTokens / Math.max(result.generateMs, 1) * 1000).toFixed(1)}/s)`
                    + ` + handoff ${handoffMs.toFixed(0)}${dropped}]`
                );
            } catch (error) {
                terminal!.log(`failed: ${(error as Error).message}`);
            }
        })();
    };

    while (true) {
        try {
            await runSession(target, onKeyframe);
        } catch (error) {
            terminal.log(`stream ended, reconnecting in ${RECONNECT_DELAY_MS / 1000}s: ${(error as Error).message}`);
        }
        await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
}

main().catch(error => {
    console.error(`[ask] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
