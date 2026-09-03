import * as fs from "fs";
import * as path from "path";
import { StreamDecoder } from "../src/streamDecoder";
import { encodeJpeg } from "../src/jpeg";
import { parseSps, nalType, NAL_TYPE_SPS } from "../src/h264";
import { findOutputDirectory } from "../src/paths";

const KEYFRAME_SUBDIRECTORY = "failed-keyframes";
const ROUNDS = 20;

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
    const names = (await fs.promises.readdir(source)).filter(name => name.endsWith(".h264")).sort();
    const unit = await fs.promises.readFile(path.join(source, names[0]));
    const sps = splitAnnexB(unit).find(nal => nalType(nal) === NAL_TYPE_SPS);
    if (!sps) {
        throw new Error(`The first access unit has no SPS`);
    }
    const { width, height } = parseSps(sps);

    const decoder = new StreamDecoder();
    await decoder.start();
    const frames = await decoder.decode(unit, width, height);
    decoder.close();
    const image = frames[0];
    if (!image) {
        throw new Error(`Nothing decoded`);
    }

    const startedAtMs = Date.now();
    let bytes = 0;
    for (let round = 0; round < ROUNDS; round++) {
        bytes = encodeJpeg(image.rgb, image.width, image.height).length;
    }
    const each = (Date.now() - startedAtMs) / ROUNDS;
    console.log(`[jpeg] ${width}x${height}: ${each.toFixed(1)} ms per encode, ${(bytes / 1024).toFixed(0)} KiB each`);
    console.log(`[jpeg] that blocks the event loop, so it costs ${(each / 66 * 100).toFixed(0)}% of one 15fps frame interval`);
}

main().catch(error => {
    console.error(`[jpeg] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
