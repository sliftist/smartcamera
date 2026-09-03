import * as fs from "fs";
import * as path from "path";
import { loadViews } from "../src/views";
import { RtspClient } from "../src/rtsp";
import { AccessUnit, H264Depacketizer, isKeyframe, nalType, parseParameterSets, parseSps, toAnnexB, NAL_TYPE_PPS, NAL_TYPE_SPS } from "../src/h264";
import { decodeKeyframe, initializeDecoder } from "../src/decoder";
import { rotate180 } from "../src/overlay";
import { encodeJpeg } from "../src/jpeg";
import { RgbImage } from "../src/yolo";
import { LlamaAskClient } from "../src/askLlama";

const FRAME_DIRECTORY = path.join(__dirname, "..", "bench-frames");
const FRAME_COUNT = 4;
const FRAME_SPACING_MS = 4000;
/**
 * Image sizes to sweep, longest edge first. Qwen3-VL charges tokens by area, so this is the single
 * biggest lever on latency and it trades directly against how much detail the model can see.
 */
const IMAGE_SIZES = [[1920, 1080], [1280, 704], [896, 504], [640, 360]];

/** What this camera is actually asked in anger: a yes or no, a count, and a short description. */
const PROMPTS = [
    "Is there a person in this image? Answer only yes or no.",
    "How many people are in this image? Answer with a single number and nothing else.",
    "In one short sentence, what is happening in this image?",
];

function log(message: string) {
    console.log(message);
}

async function captureFrames(): Promise<RgbImage[]> {
    const cached = fs.existsSync(FRAME_DIRECTORY)
        // Numbered frames only: the results file lives in here too and is not one of them.
        ? fs.readdirSync(FRAME_DIRECTORY).filter(name => /^\d+\.json$/.test(name)).sort()
        : [];
    if (cached.length >= FRAME_COUNT) {
        log(`[bench] reusing ${cached.length} cached frames from ${FRAME_DIRECTORY}`);
        return cached.map(name => {
            const meta = JSON.parse(fs.readFileSync(path.join(FRAME_DIRECTORY, name), "utf8")) as { width: number; height: number };
            const rgb = fs.readFileSync(path.join(FRAME_DIRECTORY, name.replace(/\.json$/, ".rgb")));
            return { width: meta.width, height: meta.height, rgb };
        });
    }

    fs.mkdirSync(FRAME_DIRECTORY, { recursive: true });
    await initializeDecoder();
    const views = await loadViews();
    if (views.length === 0) {
        throw new Error(`Found no view batch files to watch`);
    }
    const view = views[0];
    const client = new RtspClient(view.target);
    await client.connect();
    const tracks = await client.describe();
    const video = tracks.find(track => track.kind === "video");
    if (!video) {
        throw new Error(`The stream has no video track`);
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

    const frames: RgbImage[] = [];
    let lastTakenAtMs = 0;
    const done = new Promise<void>(resolve => {
        const depacketizer = new H264Depacketizer((unit: AccessUnit) => {
            for (const nal of unit.nals) {
                if (nalType(nal) === NAL_TYPE_SPS) {
                    sps = nal;
                } else if (nalType(nal) === NAL_TYPE_PPS) {
                    pps = nal;
                }
            }
            // Spaced out so the frames differ, which is the only thing that makes an accuracy
            // comparison across quantizations worth anything.
            if (frames.length >= FRAME_COUNT || !isKeyframe(unit) || !sps || !pps) {
                return;
            }
            if (Date.now() - lastTakenAtMs < FRAME_SPACING_MS) {
                return;
            }
            lastTakenAtMs = Date.now();
            const slices = unit.nals.filter(nal => nalType(nal) !== NAL_TYPE_SPS && nalType(nal) !== NAL_TYPE_PPS);
            const { width, height } = parseSps(sps);
            const annexB = toAnnexB([sps, pps, ...slices]);
            void (async () => {
                const image = await decodeKeyframe(annexB, width, height);
                if (view.upsideDown) {
                    rotate180(image);
                }
                const index = frames.length;
                frames.push(image);
                const stem = path.join(FRAME_DIRECTORY, String(index).padStart(2, "0"));
                fs.writeFileSync(`${stem}.rgb`, image.rgb);
                fs.writeFileSync(`${stem}.json`, JSON.stringify({ width: image.width, height: image.height }));
                fs.writeFileSync(`${stem}.jpg`, encodeJpeg(image.rgb, image.width, image.height));
                log(`[bench] captured frame ${index + 1}/${FRAME_COUNT} (${image.width}x${image.height})`);
                if (frames.length >= FRAME_COUNT) {
                    resolve();
                }
            })();
        });
        client.onRtpPacket = packet => {
            if (packet.channel === 0) {
                depacketizer.push(packet);
            }
        };
    });

    await client.setupInterleaved(video, 0);
    await client.play();
    await done;
    await client.close();
    return frames;
}

type Measurement = {
    model: string;
    width: number;
    height: number;
    prompt: string;
    frame: number;
    /** True when this frame's pixels had not been seen yet, which is every frame in real use. */
    cold: boolean;
    answer: string;
    prefillMs: number;
    generateMs: number;
    promptTokens: number;
    outputTokens: number;
};

async function benchmarkModel(model: string, frames: RgbImage[]): Promise<Measurement[]> {
    process.env.SMARTCAMERA_MODEL = model;
    const measurements: Measurement[] = [];

    for (const [width, height] of IMAGE_SIZES) {
        process.env.SMARTCAMERA_IMAGE_WIDTH = String(width);
        process.env.SMARTCAMERA_IMAGE_HEIGHT = String(height);
        const client = new LlamaAskClient(path.join(__dirname, ".."), message => log(`  ${message}`));
        const startedAtMs = Date.now();
        const imageTokens = await client.start();
        log(`[bench] ${model} at ${width}x${height}: loaded in ${((Date.now() - startedAtMs) / 1000).toFixed(1)}s, ${imageTokens} image tokens per frame`);
        try {
            // Frames rotate on the outer loop, so the first question about each one always pays the
            // full vision and prefill cost, which is what every frame costs once this is live. The
            // questions after it reuse the cached image prefix, which is what a multi prompt batch
            // actually costs. Both are real, so both are reported rather than averaged together.
            for (let frame = 0; frame < frames.length; frame++) {
                for (let index = 0; index < PROMPTS.length; index++) {
                    const result = await client.ask(frames[frame], PROMPTS[index]);
                    measurements.push({
                        model, width, height, frame,
                        prompt: PROMPTS[index],
                        cold: index === 0,
                        answer: result.answer,
                        prefillMs: result.prefillMs + result.visionMs,
                        generateMs: result.generateMs,
                        promptTokens: result.promptTokens,
                        outputTokens: result.outputTokens,
                    });
                }
            }
        } finally {
            client.stop();
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    return measurements;
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function main() {
    const models = process.argv.slice(2);
    if (models.length === 0) {
        console.log(`Usage: yarn bench:quant <model.gguf> [more.gguf ...]`);
        process.exit(1);
    }
    const frames = await captureFrames();

    const all: Measurement[] = [];
    for (const model of models) {
        all.push(...await benchmarkModel(model, frames));
    }

    console.log(`\n=== cold: a new frame, first question (what every frame costs live) ===`);
    console.log(`${"model".padEnd(34)} ${"size".padEnd(10)} ${"tokens".padStart(7)} ${"prefill".padStart(8)} ${"tok/s".padStart(8)} ${"generate".padStart(9)} ${"total".padStart(8)}`);
    for (const model of models) {
        for (const [width, height] of IMAGE_SIZES) {
            const rows = all.filter(row => row.model === model && row.width === width && row.cold);
            if (rows.length === 0) {
                continue;
            }
            const prefillMs = median(rows.map(row => row.prefillMs));
            const promptTokens = median(rows.map(row => row.promptTokens));
            const generateMs = median(rows.map(row => row.generateMs));
            console.log(`${model.replace("Qwen3-VL-8B-Instruct-", "").padEnd(34)}`
                + ` ${`${width}x${height}`.padEnd(10)}`
                + ` ${promptTokens.toFixed(0).padStart(7)}`
                + ` ${`${prefillMs.toFixed(0)}ms`.padStart(8)}`
                + ` ${(promptTokens / (prefillMs / 1000)).toFixed(0).padStart(8)}`
                + ` ${`${generateMs.toFixed(0)}ms`.padStart(9)}`
                + ` ${`${(prefillMs + generateMs).toFixed(0)}ms`.padStart(8)}`);
        }
    }

    console.log(`\n=== warm: another question about a frame already seen ===`);
    console.log(`${"model".padEnd(34)} ${"size".padEnd(10)} ${"prefill".padStart(8)} ${"generate".padStart(9)} ${"gen tok/s".padStart(10)}`);
    for (const model of models) {
        for (const [width, height] of IMAGE_SIZES) {
            const rows = all.filter(row => row.model === model && row.width === width && !row.cold);
            if (rows.length === 0) {
                continue;
            }
            const generateMs = median(rows.map(row => row.generateMs));
            const outputTokens = median(rows.map(row => row.outputTokens));
            console.log(`${model.replace("Qwen3-VL-8B-Instruct-", "").padEnd(34)}`
                + ` ${`${width}x${height}`.padEnd(10)}`
                + ` ${`${median(rows.map(row => row.prefillMs)).toFixed(0)}ms`.padStart(8)}`
                + ` ${`${generateMs.toFixed(0)}ms`.padStart(9)}`
                + ` ${(generateMs > 0 ? outputTokens / (generateMs / 1000) : 0).toFixed(1).padStart(10)}`);
        }
    }

    console.log(`\n=== answers ===`);
    for (let frame = 0; frame < frames.length; frame++) {
        for (const prompt of PROMPTS) {
            console.log(`\nframe ${frame}  ${JSON.stringify(prompt)}`);
            for (const model of models) {
                for (const [width, height] of IMAGE_SIZES) {
                    const row = all.find(candidate => candidate.model === model && candidate.width === width
                        && candidate.prompt === prompt && candidate.frame === frame);
                    if (row) {
                        console.log(`  ${model.replace("Qwen3-VL-8B-Instruct-", "").padEnd(20)} ${`${width}x${height}`.padEnd(10)} ${JSON.stringify(row.answer)}`);
                    }
                }
            }
        }
    }

    const report = path.join(__dirname, "..", "bench-frames", "results.json");
    fs.writeFileSync(report, JSON.stringify(all, undefined, 2));
    console.log(`\n[bench] wrote ${report}`);
}

main().catch(error => {
    console.error(`[bench] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
