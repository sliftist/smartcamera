import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { decodeKeyframe } from "./src/decoder";
import { nalType, parseSps, NAL_TYPE_SPS } from "./src/h264";
import { encodeJpeg } from "./src/jpeg";
import { findOutputDirectory } from "./src/paths";

const KEYFRAME_SUBDIRECTORY = "failed-keyframes";
// The old ffmpeg.wasm core died permanently at 99 decodes, so run far past that.
const STRESS_DECODES = 200;
const PROGRESS_EVERY = 100;

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

async function firstSavedKeyframe(): Promise<string> {
    const directory = path.join(await findOutputDirectory(), KEYFRAME_SUBDIRECTORY);
    const names = (await fs.promises.readdir(directory)).filter(name => name.endsWith(".h264")).sort();
    if (names.length === 0) {
        throw new Error(`Expected .h264 access units in ${directory}, or pass a file`);
    }
    return path.join(directory, names[0]);
}

async function main() {
    const file = process.argv[2] || await firstSavedKeyframe();
    const annexB = await fs.promises.readFile(file);
    const nals = splitAnnexB(annexB);
    console.log(`[probe] ${file}: ${annexB.length} bytes, ${nals.length} NALs, types [${nals.map(nalType).join(", ")}]`);

    const sps = nals.find(nal => nalType(nal) === NAL_TYPE_SPS);
    if (!sps) {
        throw new Error(`The saved frame has no SPS, so its resolution is unknown`);
    }
    const info = parseSps(sps);
    console.log(`[probe] SPS: ${info.profileName} profile, level ${info.levelIdc / 10}, ${info.width}x${info.height}`);

    const first = await decodeKeyframe(annexB, info.width, info.height);
    const preview = path.join(os.tmpdir(), "decoded.jpg");
    await fs.promises.writeFile(preview, encodeJpeg(first.rgb, first.width, first.height));
    console.log(`[probe] wrote a decoded frame to ${preview}`);

    let failures = 0;
    const startedAtMs = Date.now();
    for (let run = 1; run <= STRESS_DECODES; run++) {
        try {
            const frame = await decodeKeyframe(annexB, info.width, info.height);
            if (run % PROGRESS_EVERY === 0) {
                const memory = process.memoryUsage();
                console.log(`[probe] decode ${run}/${STRESS_DECODES} ok (${frame.width}x${frame.height}, ${((Date.now() - startedAtMs) / run).toFixed(0)}ms average, rss ${(memory.rss / 1024 / 1024).toFixed(0)} MiB, external ${(memory.external / 1024 / 1024).toFixed(0)} MiB)`);
            }
        } catch (error) {
            failures++;
            console.error(`[probe] decode ${run} failed:`, (error as Error).message ?? error);
        }
    }
    console.log(`[probe] ${STRESS_DECODES - failures}/${STRESS_DECODES} decodes succeeded in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s`);

    process.exit(failures > 0 ? 1 : 0);
}

main().catch(error => {
    console.error(`[probe] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
