import * as fs from "fs";
import * as path from "path";
import { StreamDecoder } from "../src/streamDecoder";
import { parseSps, nalType, NAL_TYPE_SPS } from "../src/h264";
import { findOutputDirectory } from "../src/paths";

const KEYFRAME_SUBDIRECTORY = "failed-keyframes";
const ROUNDS = 3;

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
    const directory = process.argv[2] || path.join(await findOutputDirectory(), KEYFRAME_SUBDIRECTORY);
    const names = (await fs.promises.readdir(directory)).filter(name => name.endsWith(".h264")).sort();
    if (names.length === 0) {
        throw new Error(`Expected .h264 access units in ${directory}`);
    }
    const units = await Promise.all(names.map(name => fs.promises.readFile(path.join(directory, name))));
    const sps = splitAnnexB(units[0]).find(nal => nalType(nal) === NAL_TYPE_SPS);
    if (!sps) {
        throw new Error(`The first access unit has no SPS`);
    }
    const { width, height } = parseSps(sps);
    const totalBytes = units.reduce((sum, unit) => sum + unit.length, 0);
    console.log(`[rate] ${units.length} access units, ${width}x${height}, ${(totalBytes / 2 ** 20).toFixed(1)} MiB total`);
    console.log(`[rate] these are all IDR frames, which are the most expensive kind to decode`);

    const decoder = new StreamDecoder();
    await decoder.start();

    let decoded = 0;
    let failed = 0;
    for (let round = 0; round < ROUNDS; round++) {
        const startedAtMs = Date.now();
        let roundDecoded = 0;
        for (const unit of units) {
            try {
                const frames = await decoder.decode(unit, width, height);
                roundDecoded += frames.length;
            } catch {
                failed++;
                decoder.reset();
            }
        }
        const elapsed = (Date.now() - startedAtMs) / 1000;
        decoded += roundDecoded;
        console.log(`[rate] round ${round + 1}: ${roundDecoded} frames in ${elapsed.toFixed(2)}s`
            + ` = ${(roundDecoded / elapsed).toFixed(1)} fps, ${(elapsed / Math.max(roundDecoded, 1) * 1000).toFixed(1)} ms/frame`);
    }
    decoder.close();

    console.log(`[rate] decoded ${decoded} frames, ${failed} access units failed`);
}

main().catch(error => {
    console.error(`[rate] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
