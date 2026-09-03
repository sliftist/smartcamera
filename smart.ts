import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { formatDateTime } from "socket-function/src/formatting/format";
import { fileExists, readStreamTarget, redactUrl, StreamTarget } from "./src/credentials";
import { RtspClient } from "./src/rtsp";
import { AccessUnit, H264Depacketizer, isKeyframe, nalType, parseParameterSets, parseSps, toAnnexB, NAL_TYPE_PPS, NAL_TYPE_SPS } from "./src/h264";
import { decodeKeyframe, initializeDecoder, setFailedFrameDirectory } from "./src/decoder";
import { dayStamp, secondStamp } from "./src/timestamps";
import { outputDirectory } from "./src/paths";
import { detect, loadModel, Detection, MODELS, ModelName, RgbImage } from "./src/yolo";
import { cropImage, drawDetections, rotate180, CropRegion } from "./src/overlay";
import { encodeJpeg } from "./src/jpeg";

const VIDEO_CHANNEL = 0;
const PROFILE_INTERVAL_MS = 60 * 1000;
const IMAGE_INTERVAL_MS = 60 * 1000;
const RECONNECT_DELAY_MS = 5 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
// Screenshots are for debugging, so today and yesterday are kept and everything older is dropped.
const IMAGE_DAYS_KEPT = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const FAILED_FRAME_FOLDER = "failed-keyframes";
const DETECTIONS_COLUMN_WIDTH = 52;
const TIMESTAMP_COLUMN_WIDTH = 22;

const DEFAULT_MODEL: ModelName = "nano";

function printHelp() {
    console.log(`
Records an RTSP camera, runs YOLO26 over every keyframe, and writes the results to disk.

  yarn smart <credentials file> [${MODELS.map(model => model.name).join(" | ")}] [upsidedown] [crop-0-50-0-100] [help]

Arguments can be given in any order, with or without leading dashes. The one argument that is not a
recognised word is taken as the path to the file holding the rtsp:// url with the camera credentials
(a VLC .bat launcher works). The password is only ever read from that file, never logged.

  ${MODELS.map(model => model.name).join(", ")}    which YOLO26 model to run, default ${DEFAULT_MODEL}
  upsidedown             rotate each frame 180 degrees before anything else sees it
  crop-<x0>-<x1>-<y0>-<y1>  keep only that part of the frame, in percent, applied after the rotation
  help                   print this

Output goes to ./output/<ip>_<port>/:

  2026-08-01.md           one line per keyframe: time, detections, model, timings, image, boxes
  2026-08-01/             one overlaid image per ${IMAGE_INTERVAL_MS / 1000} seconds, named after its timestamp

Detection logs are kept forever. Screenshots are only kept for the last ${IMAGE_DAYS_KEPT} days, swept hourly.
`.trim());
}

type Arguments = {
    credentialsFile: string;
    model: ModelName;
    upsideDown: boolean;
    crop: CropRegion | undefined;
};

const UPSIDE_DOWN_WORDS = ["upsidedown", "upside-down"];
const CROP_PATTERN = /^crop-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/;
const MAX_PERCENT = 100;

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
    let model = DEFAULT_MODEL;
    let upsideDown = false;
    let crop: CropRegion | undefined;

    for (const argument of argv) {
        const word = argument.replace(/^-+/, "").toLowerCase();
        if (word === "help") {
            return undefined;
        }
        if (UPSIDE_DOWN_WORDS.includes(word)) {
            upsideDown = true;
            continue;
        }
        const parsedCrop = parseCrop(word);
        if (parsedCrop) {
            crop = parsedCrop;
            continue;
        }
        const named = MODELS.find(candidate => candidate.name === word);
        if (named) {
            model = named.name;
            continue;
        }
        if (await fileExists(argument)) {
            credentialsFile = argument;
            continue;
        }
        console.error(`Unrecognised argument ${JSON.stringify(argument)}: it is not a model name and not a file that exists.\n`);
        return undefined;
    }

    if (!credentialsFile) {
        return undefined;
    }
    return { credentialsFile, model, upsideDown, crop };
}

function describeDetections(detections: Detection[]): string {
    if (detections.length === 0) {
        return "(nothing)";
    }
    return detections.map(detection => `**${detection.className}** ${(detection.score * 100).toFixed(0)}%`).join(", ");
}

/** Pads to a visible width, ignoring the markdown emphasis markers so the columns still line up. */
function padVisible(text: string, width: number): string {
    const visibleLength = text.split("**").join("").length;
    return text + " ".repeat(Math.max(0, width - visibleLength));
}

function describeBoxes(detections: Detection[]): string {
    return detections.map(detection =>
        `${detection.className}[${Math.round(detection.x)},${Math.round(detection.y)} ${Math.round(detection.width)}x${Math.round(detection.height)}]`
    ).join(" ");
}

class Recorder {
    private outputDirectory: string;
    private lastImageAtMs = 0;
    private busy = false;

    private keyframesSeen = 0;
    private keyframesProcessed = 0;
    private keyframesSkipped = 0;
    private detectionCount = 0;
    private imagesSaved = 0;
    private decodeTotalMs = 0;
    private decodeMaxMs = 0;
    private detectTotalMs = 0;
    private detectMaxMs = 0;
    private profiledAtMs = Date.now();

    constructor(target: StreamTarget, private model: ModelName, private upsideDown: boolean, private crop: CropRegion | undefined) {
        this.outputDirectory = outputDirectory(target);
    }

    get directory(): string {
        return this.outputDirectory;
    }

    async start() {
        await fs.promises.mkdir(this.outputDirectory, { recursive: true });
        setFailedFrameDirectory(path.join(this.outputDirectory, FAILED_FRAME_FOLDER));
        await this.removeOldImages();
        setInterval(() => {
            void this.removeOldImages().catch(error => {
                console.error(`[smart] failed to remove old screenshots:`, (error as Error).stack ?? error);
            });
        }, CLEANUP_INTERVAL_MS);
    }

    /** Only ever removes day folders of screenshots; the detection logs are kept forever. */
    private async removeOldImages() {
        const keep = new Set<string>();
        for (let day = 0; day < IMAGE_DAYS_KEPT; day++) {
            keep.add(dayStamp(Date.now() - day * DAY_MS));
        }
        const entries = await fs.promises.readdir(this.outputDirectory, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory() || !DAY_FOLDER_PATTERN.test(entry.name) || keep.has(entry.name)) {
                continue;
            }
            const folder = path.join(this.outputDirectory, entry.name);
            const images = await fs.promises.readdir(folder);
            await fs.promises.rm(folder, { recursive: true, force: true });
            console.log(`[smart] removed ${images.length} old screenshots from ${entry.name}`);
        }
    }

    /** Dropping a keyframe is better than falling further behind, and the count shows up in the profile line. */
    offer(image: () => Promise<RgbImage>) {
        this.keyframesSeen++;
        if (this.busy) {
            this.keyframesSkipped++;
            return;
        }
        this.busy = true;
        void this.process(image).catch(error => {
            console.error(`[smart] failed to process a keyframe:`, (error as Error).stack ?? error);
        }).finally(() => {
            this.busy = false;
        });
    }

    private async process(getImage: () => Promise<RgbImage>) {
        const receivedAtMs = Date.now();
        const decoded = await getImage();
        // Both happen before anything looks at the frame, so the detections, their boxes and the saved
        // image are all in the same coordinate space.
        if (this.upsideDown) {
            rotate180(decoded);
        }
        const image = this.crop ? cropImage(decoded, this.crop) : decoded;
        const decodeMs = Date.now() - receivedAtMs;

        const result = await detect(image, this.model);
        const detections = [...result.detections].sort((a, b) => b.score - a.score);
        const detectMs = result.preprocessMs + result.inferenceMs + result.postprocessMs;

        this.keyframesProcessed++;
        this.detectionCount += detections.length;
        this.decodeTotalMs += decodeMs;
        this.decodeMaxMs = Math.max(this.decodeMaxMs, decodeMs);
        this.detectTotalMs += detectMs;
        this.detectMaxMs = Math.max(this.detectMaxMs, detectMs);

        let imageReference = "";
        if (receivedAtMs - this.lastImageAtMs >= IMAGE_INTERVAL_MS) {
            this.lastImageAtMs = receivedAtMs;
            imageReference = await this.saveImage(image, detections, receivedAtMs);
            this.imagesSaved++;
        }

        await this.appendLine(receivedAtMs, detections, decodeMs, result, imageReference);
    }

    private async saveImage(image: RgbImage, detections: Detection[], time: number): Promise<string> {
        const folder = path.join(this.outputDirectory, dayStamp(time));
        await fs.promises.mkdir(folder, { recursive: true });
        const file = path.join(folder, `${secondStamp(time)}.jpg`);
        const overlaid = drawDetections(image, detections);
        await fs.promises.writeFile(file, encodeJpeg(overlaid.rgb, overlaid.width, overlaid.height));
        return pathToFileURL(file).href;
    }

    private async appendLine(time: number, detections: Detection[], decodeMs: number, result: { preprocessMs: number; inferenceMs: number; postprocessMs: number }, imageReference: string) {
        const fields = [
            formatDateTime(time).padEnd(TIMESTAMP_COLUMN_WIDTH),
            padVisible(describeDetections(detections), DETECTIONS_COLUMN_WIDTH),
            this.model.padEnd(6),
            `decode ${decodeMs}ms, detect ${result.inferenceMs}ms (+${result.preprocessMs + result.postprocessMs}ms)`,
            imageReference,
            describeBoxes(detections),
        ];
        const file = path.join(this.outputDirectory, `${dayStamp(time)}.md`);
        await fs.promises.appendFile(file, fields.join(" | ") + "\n");
    }

    profileIfDue(client: RtspClient) {
        const now = Date.now();
        if (now - this.profiledAtMs < PROFILE_INTERVAL_MS) {
            return;
        }
        const elapsedSeconds = (now - this.profiledAtMs) / 1000;
        this.profiledAtMs = now;

        const processed = Math.max(1, this.keyframesProcessed);
        console.log([
            formatDateTime(now),
            `${this.keyframesProcessed} keyframes in ${elapsedSeconds.toFixed(0)}s`,
            `decode avg ${(this.decodeTotalMs / processed).toFixed(0)}ms max ${this.decodeMaxMs}ms`,
            `detect avg ${(this.detectTotalMs / processed).toFixed(0)}ms max ${this.detectMaxMs}ms`,
            `${this.detectionCount} detections`,
            `${this.imagesSaved} images`,
            `${(client.bytesReceived / 1024 / 1024).toFixed(2)} MiB, framing ${client.dataHandlerMs.toFixed(0)}ms`,
            `${this.keyframesSkipped} skipped, ${client.resyncCount} resyncs`,
        ].join(" | "));

        this.keyframesSeen = 0;
        this.keyframesProcessed = 0;
        this.keyframesSkipped = 0;
        this.detectionCount = 0;
        this.imagesSaved = 0;
        this.decodeTotalMs = 0;
        this.decodeMaxMs = 0;
        this.detectTotalMs = 0;
        this.detectMaxMs = 0;
    }
}

async function runSession(target: StreamTarget, recorder: Recorder) {
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
        recorder.offer(() => decodeKeyframe(annexB, width, height));
    });

    client.onRtpPacket = packet => {
        if (packet.channel !== VIDEO_CHANNEL) {
            return;
        }
        depacketizer.push(packet);
        recorder.profileIfDue(client);
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
    const recorder = new Recorder(target, parsed.model, parsed.upsideDown, parsed.crop);
    await recorder.start();
    const crop = parsed.crop ? `, cropping to x ${parsed.crop.xStart}-${parsed.crop.xEnd}% y ${parsed.crop.yStart}-${parsed.crop.yEnd}%` : "";
    console.log(`[smart] ${redactUrl(target.url)} with YOLO26 ${parsed.model}${parsed.upsideDown ? ", rotating the image 180 degrees" : ""}${crop}, writing to ${recorder.directory}`);

    await initializeDecoder();
    await loadModel(parsed.model);

    while (true) {
        try {
            await runSession(target, recorder);
        } catch (error) {
            console.error(`[smart] stream ended, reconnecting in ${RECONNECT_DELAY_MS / 1000}s:`, (error as Error).stack ?? error);
        }
        await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
    }
}

main().catch(error => {
    console.error(`[smart] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
