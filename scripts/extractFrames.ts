import * as fs from "fs";
import * as path from "path";
import { Demuxer, Decoder, SoftwareScaleContext, AVPixelFormat, AV_PIX_FMT_RGB24, SWS_BILINEAR } from "node-av";
import { encode as encodeJpeg } from "jpeg-js";

/**
 * One frame a second out of every door clip, written to disk as jpegs.
 *
 * The frames are extracted once and then left alone. Decoding is the slow part of asking the model
 * anything about a clip, and it produces the same pixels every time, so paying for it once and
 * reading images afterwards is the difference between an experiment that takes minutes and one that
 * takes hours. It also means every run sees exactly the same input, which is the only way to tell a
 * change in a prompt from a change in what the prompt was looking at.
 *
 * A second apart is chosen against what is being looked for. A delivery takes many seconds: someone
 * walks up, stops, puts something down and leaves. Sampling faster would multiply the cost without
 * showing anything new, and slower would start to miss the moment the package is actually visible.
 */

const CLIP_ROOT = path.join(__dirname, "..", "doorclips");
const FRAME_ROOT = path.join(__dirname, "..", "doorframes");
const CLIP_NAME = /_(\d+)\.mp4$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** Kept at the camera's aspect, well above what the model is shown, so the sample never limits it. */
const WIDTH = 1280;
const HEIGHT = 720;
const SECOND_MS = 1000;
const QUALITY = 88;

function log(message: string) {
    console.log(`${new Date().toISOString().slice(11, 19)} | ${message}`);
}

function clips(): { day: string; file: string }[] {
    const out: { day: string; file: string }[] = [];
    for (const day of fs.readdirSync(CLIP_ROOT).filter(name => DAY_FOLDER.test(name)).sort()) {
        for (const file of fs.readdirSync(path.join(CLIP_ROOT, day)).filter(name => CLIP_NAME.test(name)).sort()) {
            out.push({ day, file });
        }
    }
    return out;
}

export function framesFolder(day: string, file: string): string {
    return path.join(FRAME_ROOT, day, file.replace(/\.mp4$/, ""));
}

async function extract(day: string, file: string): Promise<number> {
    const folder = framesFolder(day, file);
    const demuxer = await Demuxer.open(path.join(CLIP_ROOT, day, file));
    const stream = demuxer.video();
    if (!stream) {
        return 0;
    }
    const timeBase = stream.timeBase;
    const decoder = await Decoder.create(stream);
    const scaler = new SoftwareScaleContext();
    let configured = "";
    let written = 0;
    let firstPts = -1;
    let nextAtMs = 0;

    fs.mkdirSync(folder, { recursive: true });
    for await (const frame of decoder.frames(demuxer.packets(stream.index))) {
        if (!frame) {
            continue;
        }
        const pts = Number(frame.pts);
        if (firstPts < 0) {
            firstPts = pts;
        }
        const atMs = ((pts - firstPts) * timeBase.num * 1000) / timeBase.den;
        if (atMs + 1 < nextAtMs) {
            frame.free?.();
            continue;
        }
        nextAtMs = Math.floor(atMs / SECOND_MS) * SECOND_MS + SECOND_MS;

        const source = `${frame.width}x${frame.height}:${frame.format}`;
        if (configured !== source) {
            scaler.getContext(frame.width, frame.height, frame.format as AVPixelFormat, WIDTH, HEIGHT, AV_PIX_FMT_RGB24, SWS_BILINEAR);
            configured = source;
        }
        const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
        await scaler.scale(frame.data!, frame.linesize, 0, frame.height, [rgb], [WIDTH * 3]);
        // jpeg-js wants four channels. The alpha is thrown away by the encoder but has to be there.
        const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
        for (let i = 0, at = 0; i < WIDTH * HEIGHT; i++) {
            rgba[at++] = rgb[i * 3];
            rgba[at++] = rgb[i * 3 + 1];
            rgba[at++] = rgb[i * 3 + 2];
            rgba[at++] = 255;
        }
        // Named by the second it came from, so a frame's place in the clip is readable from the file.
        const name = `${String(Math.round(atMs / SECOND_MS)).padStart(3, "0")}.jpg`;
        fs.writeFileSync(path.join(folder, name), encodeJpeg({ data: rgba, width: WIDTH, height: HEIGHT }, QUALITY).data);
        written++;
        frame.free?.();
    }
    // Says the clip finished rather than died part way, so a resumed run can tell the difference.
    fs.writeFileSync(path.join(folder, "done"), String(written));
    return written;
}

async function main() {
    const argv = process.argv.slice(2);
    const shardFlag = argv.indexOf("--shard");
    // Split across processes, because decoding is the whole cost here and one process uses one core.
    const [index, total] = shardFlag >= 0 ? argv[shardFlag + 1].split("/").map(Number) : [0, 1];

    const all = clips();
    const mine = all.filter((_, at) => at % total === index);
    log(`shard ${index + 1} of ${total}: ${mine.length} clips of ${all.length}`);

    let done = 0;
    let frames = 0;
    for (const clip of mine) {
        if (fs.existsSync(path.join(framesFolder(clip.day, clip.file), "done"))) {
            done++;
            continue;
        }
        try {
            frames += await extract(clip.day, clip.file);
        } catch (error) {
            log(`${clip.day}/${clip.file} failed: ${(error as Error).message}`);
        }
        done++;
        if (done % 20 === 0) {
            log(`${done} of ${mine.length}, ${frames} frames`);
        }
    }
    log(`shard ${index + 1} done: ${done} clips, ${frames} frames`);
    process.exit(0);
}

main().catch(error => {
    console.error(`[extractFrames] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
