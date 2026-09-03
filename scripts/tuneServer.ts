import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { buildPrompt, DEFAULT_WATCHES } from "../src/questions";

/**
 * Times one real question against one real frame under different llama.cpp settings.
 *
 * Everything else must be off the card while this runs, or the numbers are two workloads fighting
 * over one gpu rather than a measurement.
 *
 * A round is three separable costs and they respond to different things, so they are reported apart:
 * encoding the image, prefilling the prompt, and generating the answer. Vision is not reported by
 * llama.cpp at all, so it is inferred by asking the same length of plain text and subtracting.
 */

const REPO = path.join(__dirname, "..");
const SERVER = process.env.TUNE_SERVER || "/root/eye/llama.cpp/build/bin/llama-server";
const PORT = 8899;
const MODEL = process.env.TUNE_MODEL || path.join(REPO, "models", "Qwen3-VL-8B-Instruct-Q8_0.gguf");
const MMPROJ = path.join(REPO, "models", "mmproj-F16.gguf");
const FRAME = path.join(REPO, "bench-frames", "tune.jpg");
const RUNS = 5;

type Timing = { promptMs: number; promptTokens: number; generateMs: number; outputTokens: number };

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

async function waitForHealth(child: ChildProcess, within: number): Promise<boolean> {
    const deadline = Date.now() + within;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            return false;
        }
        try {
            if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) {
                return true;
            }
        } catch {
            // Not listening yet.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
}

async function ask(prompt: string, jpeg: string | undefined, maxTokens: number): Promise<Timing> {
    const content: unknown[] = [];
    if (jpeg) {
        content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg}` } });
    }
    content.push({ type: "text", text: prompt });
    const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Every round in real use is a new frame, so a cached prefix is not a thing that happens.
        // Left on, five identical asks measure the cache rather than the model.
        body: JSON.stringify({ messages: [{ role: "user", content }], max_tokens: maxTokens, temperature: 0, stream: false, cache_prompt: false }),
    });
    const body = await response.json() as { timings?: Record<string, number>; error?: { message?: string } };
    if (body.error) {
        throw new Error(body.error.message ?? "the model refused");
    }
    const timings = body.timings ?? {};
    return {
        promptMs: timings.prompt_ms ?? 0,
        promptTokens: timings.prompt_n ?? 0,
        generateMs: timings.predicted_ms ?? 0,
        outputTokens: timings.predicted_n ?? 0,
    };
}

async function measure(name: string, extra: string[]): Promise<void> {
    const args = [
        "-m", MODEL, "--mmproj", MMPROJ, "-ngl", "99", "-c", "8192",
        "--host", "127.0.0.1", "--port", String(PORT), "--parallel", "1", "--jinja", "--no-webui",
        ...extra,
    ];
    const child = spawn(SERVER, args, { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    const output: string[] = [];
    child.stdout.on("data", chunk => output.push(String(chunk)));
    child.stderr.on("data", chunk => output.push(String(chunk)));
    try {
        if (!await waitForHealth(child, 120_000)) {
            console.log(`  ${name.padEnd(30)} did not start: ${output.join("").split("\n").filter(Boolean).slice(-2).join(" | ").slice(0, 110)}`);
            return;
        }
        const jpeg = fs.readFileSync(FRAME).toString("base64");
        const prompt = buildPrompt(DEFAULT_WATCHES);
        // A text prompt of about the same length, to separate encoding the image from prefilling it.
        const filler = `${Array.from({ length: 860 }, (_, index) => `w${index}`).join(" ")}\n${prompt}`;

        await ask(prompt, jpeg, 32);
        const withImage: Timing[] = [];
        for (let run = 0; run < RUNS; run++) {
            withImage.push(await ask(prompt, jpeg, 32));
        }
        const textOnly = await ask(filler, undefined, 1);

        const promptMs = median(withImage.map(timing => timing.promptMs));
        const generateMs = median(withImage.map(timing => timing.generateMs));
        const tokens = median(withImage.map(timing => timing.promptTokens));
        // Same token count, no image: what is left is what the vision tower cost.
        const textRate = textOnly.promptTokens / Math.max(1, textOnly.promptMs);
        const llmPrefill = tokens / Math.max(textRate, 0.0001);
        const vision = Math.max(0, promptMs - llmPrefill);
        console.log(`  ${name.padEnd(30)}`
            + ` total ${String(Math.round(promptMs + generateMs)).padStart(5)}ms`
            + ` = vision ~${String(Math.round(vision)).padStart(4)}`
            + ` + prefill ~${String(Math.round(llmPrefill)).padStart(4)} (${tokens} tok)`
            + ` + gen ${String(Math.round(generateMs)).padStart(4)} (${median(withImage.map(t => t.outputTokens))} tok)`);
    } finally {
        child.kill("SIGKILL");
        await new Promise(resolve => setTimeout(resolve, 3000));
    }
}

async function main() {
    if (!fs.existsSync(FRAME)) {
        console.error(`Need a frame at ${FRAME}`);
        process.exit(1);
    }
    const only = process.argv.slice(2);
    const configurations: { name: string; args: string[] }[] = [
        { name: "baseline", args: [] },
        { name: "flash attention on", args: ["-fa", "on"] },
        { name: "ubatch 1024", args: ["-b", "2048", "-ub", "1024"] },
        { name: "ubatch 2048", args: ["-b", "2048", "-ub", "2048"] },
        { name: "ubatch 2048 + fa on", args: ["-b", "2048", "-ub", "2048", "-fa", "on"] },
        { name: "ubatch 4096", args: ["-b", "4096", "-ub", "4096"] },
    ];
    for (const configuration of configurations) {
        if (only.length > 0 && !only.some(want => configuration.name.includes(want))) {
            continue;
        }
        await measure(configuration.name, configuration.args);
    }
}

main().catch(error => {
    console.error(`[tune] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
