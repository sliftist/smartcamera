import * as fs from "fs";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { fileExists, readStreamTarget, redactUrl, StreamTarget } from "./src/credentials";
import { RtspClient } from "./src/rtsp";
import { AccessUnit, H264Depacketizer, isKeyframe, nalType, parseParameterSets, parseSps, toAnnexB, NAL_TYPE_PPS, NAL_TYPE_SPS } from "./src/h264";
import { VideoRecorder } from "./src/videoFile";
import { millisecondStamp } from "./src/timestamps";

const VIDEO_CHANNEL = 0;
const DEFAULT_MINUTES = 15;
const CAPTURE_DIRECTORY = path.join(__dirname, "captures");
const PROGRESS_INTERVAL_MS = 10 * 1000;
const RECONNECT_DELAY_MS = 5 * 1000;
const CTRL_C = "";
const MINUTES_PATTERN = /^\d+(?:\.\d+)?$/;

function printHelp() {
    console.log(`
Records an RTSP camera straight to a video file, without decoding anything.

  yarn capture <credentials file> [minutes]

The credentials file is the same one "yarn smart" takes (a VLC .bat launcher works).
Minutes defaults to ${DEFAULT_MINUTES}. Press any key to stop early.

Files land in ./captures/, which is not tracked by git. The camera's own H.264 is copied into an
mpegts (.ts) file as it arrives, so recording costs almost nothing and the video is not re-encoded.
`.trim());
}

type Arguments = {
    credentialsFile: string;
    minutes: number;
};

async function parseArguments(argv: string[]): Promise<Arguments | undefined> {
    let credentialsFile = "";
    let minutes = DEFAULT_MINUTES;

    for (const raw of argv) {
        const argument = raw.replace(/^--?/, "");
        if (argument === "help") {
            return undefined;
        }
        if (MINUTES_PATTERN.test(argument)) {
            minutes = parseFloat(argument);
            if (minutes <= 0) {
                console.error(`Minutes must be above zero, got ${argument}\n`);
                return undefined;
            }
            continue;
        }
        if (await fileExists(raw)) {
            credentialsFile = raw;
            continue;
        }
        console.error(`Unrecognised argument ${JSON.stringify(raw)}: it is not a number and not a file that exists.\n`);
        return undefined;
    }

    if (!credentialsFile) {
        return undefined;
    }
    return { credentialsFile, minutes };
}

function describeSize(bytes: number): string {
    if (bytes < 2 ** 20) {
        return `${(bytes / 1024).toFixed(0)} KiB`;
    }
    return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}

function describeDuration(seconds: number): string {
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

class Capture {
    private recorder: VideoRecorder | undefined;
    private stopped = false;
    private reason = "";
    private writing = Promise.resolve();

    constructor(private file: string) { }

    get isStopped(): boolean {
        return this.stopped;
    }

    get stopReason(): string {
        return this.reason;
    }

    get frames(): number {
        return this.recorder?.frameCount ?? 0;
    }

    get bytes(): number {
        return this.recorder?.byteCount ?? 0;
    }

    get seconds(): number {
        return this.recorder?.seconds ?? 0;
    }

    stop(reason: string) {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        this.reason = reason;
    }

    offer(unit: AccessUnit, sps: Buffer | undefined, pps: Buffer | undefined) {
        if (this.stopped) {
            return;
        }
        const key = isKeyframe(unit);
        // mpegts wants the parameter sets in front of each keyframe, and cameras only send them now and
        // then, so they are put back whenever they are missing.
        let nals = unit.nals;
        if (key && sps && pps && !nals.some(nal => nalType(nal) === NAL_TYPE_SPS)) {
            nals = [sps, pps, ...nals];
        }
        const annexB = toAnnexB(nals);

        if (!this.recorder) {
            if (!key || !sps) {
                return;
            }
            const { width, height } = parseSps(sps);
            const recorder = new VideoRecorder(this.file, width, height);
            this.recorder = recorder;
            this.writing = this.writing.then(async () => {
                await recorder.open();
                console.log(`${formatDateTime(Date.now())} | recording ${width}x${height} to ${this.file}`);
            });
        }
        const recorder = this.recorder;
        // Writes are chained so ffmpeg only ever sees one at a time, while rtp keeps being read.
        this.writing = this.writing.then(() => recorder.write(annexB, unit.timestamp, key)).catch(error => {
            console.error(`[capture] failed to write a frame:`, (error as Error).stack ?? error);
            this.stop("a write failed");
        });
    }

    async finish() {
        await this.writing.catch(() => undefined);
        await this.recorder?.close();
    }
}

async function runSession(target: StreamTarget, capture: Capture): Promise<void> {
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
        capture.offer(unit, sps, pps);
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
        await Promise.race([client.connectionLost(), waitUntilStopped(capture)]);
    } finally {
        await client.close();
    }
}

function waitUntilStopped(capture: Capture): Promise<void> {
    return new Promise(resolve => {
        const check = setInterval(() => {
            if (capture.isStopped) {
                clearInterval(check);
                resolve();
            }
        }, 200);
    });
}

/** Any key stops the recording; without a terminal there is nothing to press, so only the timer stops it. */
function listenForKeypress(capture: Capture) {
    if (!process.stdin.isTTY) {
        console.log(`[capture] stdin is not a terminal, so only the timer can stop this`);
        return;
    }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", key => {
        capture.stop(String(key) === CTRL_C ? "ctrl+c" : "a key was pressed");
    });
}

async function main() {
    const parsed = await parseArguments(process.argv.slice(2));
    if (!parsed) {
        printHelp();
        process.exit(0);
    }

    const target = await readStreamTarget(parsed.credentialsFile);
    await fs.promises.mkdir(CAPTURE_DIRECTORY, { recursive: true });
    const file = path.join(CAPTURE_DIRECTORY, `${target.host}_${target.port}_${millisecondStamp(Date.now())}.ts`);

    console.log(`[capture] ${redactUrl(target.url)} for up to ${parsed.minutes} minutes`);
    console.log(`[capture] press any key to stop early`);

    const capture = new Capture(file);
    listenForKeypress(capture);

    const startedAtMs = Date.now();
    const limitMs = parsed.minutes * 60 * 1000;
    const timer = setTimeout(() => capture.stop(`${parsed.minutes} minutes elapsed`), limitMs);
    const progress = setInterval(() => {
        if (capture.frames === 0) {
            return;
        }
        const elapsed = (Date.now() - startedAtMs) / 1000;
        console.log(`${formatDateTime(Date.now())} | ${describeDuration(elapsed)} elapsed, `
            + `${capture.frames} frames, ${describeSize(capture.bytes)}, ${describeDuration(capture.seconds)} of video`);
    }, PROGRESS_INTERVAL_MS);

    try {
        while (!capture.isStopped) {
            try {
                await runSession(target, capture);
            } catch (error) {
                if (capture.isStopped) {
                    break;
                }
                console.error(`[capture] stream ended, reconnecting in ${RECONNECT_DELAY_MS / 1000}s: ${(error as Error).message}`);
                await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
            }
        }
    } finally {
        clearTimeout(timer);
        clearInterval(progress);
        await capture.finish();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
    }

    const size = await fs.promises.stat(file).then(stat => stat.size).catch(() => 0);
    console.log(`[capture] stopped because ${capture.stopReason || "the stream ended"}`);
    console.log(`[capture] ${capture.frames} frames, ${describeDuration(capture.seconds)} of video, ${describeSize(size)}`);
    console.log(`[capture] ${file}`);
    process.exit(0);
}

main().catch(error => {
    console.error(`[capture] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
