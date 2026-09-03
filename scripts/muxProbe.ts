import * as fs from "fs";
import * as path from "path";
import { VideoRecorder } from "../src/videoFile";
import { parseSps, nalType, NAL_TYPE_SPS } from "../src/h264";
import { findOutputDirectory } from "../src/paths";

const KEYFRAME_SUBDIRECTORY = "failed-keyframes";
const TARGET = path.join(__dirname, "..", "captures", "muxProbe.ts");
const FRAMES = 20;
const CLOCK_HZ = 90000;
const FRAME_INTERVAL = CLOCK_HZ / 2;

function splitAnnexB(annexB: Buffer): Buffer[] {
    const nals: Buffer[] = [];
    let start = -1;
    for (let i = 0; i + 3 < annexB.length; i++) {
        if (annexB[i] !== 0 || annexB[i + 1] !== 0 || annexB[i + 2] !== 0 || annexB[i + 3] !== 1) {
            continue;
        }
        if (start >= 0) {
            nals.push(annexB.subarray(start, i));
        }
        start = i + 4;
        i += 3;
    }
    if (start >= 0) {
        nals.push(annexB.subarray(start));
    }
    return nals;
}

async function main() {
    const source = process.argv[2] || path.join(await findOutputDirectory(), KEYFRAME_SUBDIRECTORY);
    const names = (await fs.promises.readdir(source)).filter(name => name.endsWith(".h264")).sort().slice(0, FRAMES);
    if (names.length === 0) {
        throw new Error(`Expected saved keyframes in ${source}`);
    }
    const first = await fs.promises.readFile(path.join(source, names[0]));
    const sps = splitAnnexB(first).find(nal => nalType(nal) === NAL_TYPE_SPS);
    if (!sps) {
        throw new Error(`The first saved keyframe has no SPS`);
    }
    const { width, height } = parseSps(sps);
    console.log(`[mux] ${names.length} saved keyframes, ${width}x${height}`);

    await fs.promises.mkdir(path.dirname(TARGET), { recursive: true });
    const recorder = new VideoRecorder(TARGET, width, height);
    await recorder.open();
    for (let index = 0; index < names.length; index++) {
        const annexB = await fs.promises.readFile(path.join(source, names[index]));
        await recorder.write(annexB, index * FRAME_INTERVAL, true);
    }
    await recorder.close();

    const size = (await fs.promises.stat(TARGET)).size;
    console.log(`[mux] wrote ${recorder.frameCount} frames, ${recorder.seconds.toFixed(1)}s of video`);
    console.log(`[mux] ${TARGET}: ${(size / 1024).toFixed(0)} KiB`);
    if (size === 0) {
        throw new Error(`The muxed file is empty`);
    }
}

main().catch(error => {
    console.error(`[mux] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
