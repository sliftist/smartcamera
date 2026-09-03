import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { RgbImage } from "./yolo";
import { encodeJpeg } from "./jpeg";
import { resizeToFit } from "./overlay";
import { AskResult } from "./askClient";

const READY_TIMEOUT_MS = 300_000;
const RESTART_DELAY_MS = 5_000;
const HEALTH_POLL_MS = 500;
/**
 * A frame answers in about 1.5s, so a request still open after this is not slow, it is stuck. Without
 * a deadline here one wedged request stops everything for good: eye2 answers one question at a time
 * and waits on this promise, so a fetch that never settles is a permanent deadlock rather than a
 * slow reply. Seen in practice, with the server still passing its health check while a slot hung.
 */
const REQUEST_TIMEOUT_MS = 30_000;
/** Consecutive stuck requests before the server is presumed wedged and restarted out from under itself. */
const FAILURES_BEFORE_RESTART = 2;
/**
 * How long a polite kill is given before it stops being polite.
 *
 * llama.cpp installs a SIGTERM handler and shuts down gracefully, which is exactly what it cannot do
 * in the state we need to kill it in: the hang is a worker thread parked in the amd driver waiting on
 * a gpu event that never arrives, so the orderly shutdown blocks on the same thread the signal was
 * sent to escape. Seen in practice as a server that kept answering /health, ignored SIGTERM, and left
 * this client permanently convinced the model was "still loading".
 */
const KILL_GRACE_MS = 5_000;
const HOST = "127.0.0.1";
const PORT = Number(process.env.SMARTCAMERA_LLAMA_PORT || 8771);
/**
 * Qwen3-VL charges image tokens by area, so the frame is shrunk before it is ever encoded. This is the
 * same budget the TensorRT path used, and it is already finer than the camera's optics resolve.
 */
const DEFAULT_IMAGE_WIDTH = 1280;
const DEFAULT_IMAGE_HEIGHT = 704;
const CONTEXT_TOKENS = Number(process.env.SMARTCAMERA_CONTEXT || 8192);
const DEFAULT_MAX_NEW_TOKENS = 48;
/** Every layer offloaded. The point of this backend is that nothing runs on the cpu. */
const GPU_LAYERS = 99;
const MODEL_DIRECTORY = path.join(__dirname, "..", "models");
/** Everything llama.cpp prints, which is otherwise thrown away and is the only record of a hang. */
const SERVER_LOG = path.join(__dirname, "..", "logs", "llama-server.log");
const DEFAULT_MODEL = "Qwen3-VL-8B-Instruct-Q8_0.gguf";
const DEFAULT_PROJECTOR = "mmproj-F16.gguf";

/** Read per call rather than once, so a sweep can change the budget between runs in one process. */
function imageBudget(): { width: number; height: number } {
    return {
        width: Number(process.env.SMARTCAMERA_IMAGE_WIDTH || DEFAULT_IMAGE_WIDTH),
        height: Number(process.env.SMARTCAMERA_IMAGE_HEIGHT || DEFAULT_IMAGE_HEIGHT),
    };
}

function modelFile(): string {
    const configured = process.env.SMARTCAMERA_MODEL || DEFAULT_MODEL;
    return path.isAbsolute(configured) ? configured : path.join(MODEL_DIRECTORY, configured);
}

function projectorFile(): string {
    const configured = process.env.SMARTCAMERA_MMPROJ || DEFAULT_PROJECTOR;
    return path.isAbsolute(configured) ? configured : path.join(MODEL_DIRECTORY, configured);
}

function serverBinary(): string {
    return process.env.SMARTCAMERA_LLAMA_SERVER || "/root/eye/llama.cpp/build/bin/llama-server";
}

type ChatResponse = {
    choices?: { message?: { content?: string } }[];
    timings?: { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number };
    error?: { message?: string };
};

/**
 * Runs Qwen3-VL on the local gpu through a llama.cpp server and answers questions about single frames.
 *
 * Deliberately the same shape as AskClient so eye2 does not care which one it was handed. The child is
 * an http server rather than a pipe because llama.cpp already speaks http and reports its own prefill
 * and generation timings there, which is exactly what the caller wants to print.
 */
export class LlamaAskClient {
    private child: ChildProcess | undefined;
    private pending = false;
    private ready = false;
    private stopped = false;
    private imageTokens = 0;
    private consecutiveFailures = 0;
    private readyResolve: ((tokens: number) => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;

    constructor(private repoRoot: string, private onLog: (message: string) => void) { }

    start(): Promise<number> {
        this.launch();
        return new Promise<number>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
            setTimeout(() => reject(new Error(`The model did not become ready within ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS).unref();
            void this.waitUntilServing();
        });
    }

    private launch() {
        fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true });
        const model = modelFile();
        const projector = projectorFile();
        for (const file of [model, projector]) {
            if (!fs.existsSync(file)) {
                throw new Error(`Missing ${file}; download the gguf weights into ${MODEL_DIRECTORY} first`);
            }
        }
        const args = [
            "-m", model,
            "--mmproj", projector,
            "-ngl", String(GPU_LAYERS),
            "-c", String(CONTEXT_TOKENS),
            "--host", HOST,
            "--port", String(PORT),
            "--parallel", "1",
            "--jinja",
            // Whitespace separated, appended verbatim. Exists so a suspected bad kernel can be turned
            // off in the unit file and watched for an hour without a rebuild, e.g. SMARTCAMERA_LLAMA_ARGS="-fa off".
            ...(process.env.SMARTCAMERA_LLAMA_ARGS || "").split(/\s+/).filter(Boolean),
            "--no-webui",
        ];
        this.onLog(`[model] starting ${path.basename(model)} on the gpu`);
        const child = spawn(serverBinary(), args, { cwd: this.repoRoot, stdio: ["ignore", "pipe", "pipe"] });
        this.child = child;
        this.ready = false;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        // Kept, because when it hangs, what it said just before is the only account of why. Appended
        // across restarts on purpose: the interesting part is always the run that has just ended.
        const output = fs.createWriteStream(SERVER_LOG, { flags: "a" });
        output.write(`\n=== started ${new Date().toISOString()} ===\n`);
        child.stdout.on("data", chunk => output.write(chunk));
        child.stderr.on("data", chunk => output.write(chunk));
        child.on("exit", () => output.end());
        child.on("error", error => this.onLog(`[model] could not be spawned: ${(error as Error).message}`));
        child.on("exit", (code, signal) => {
            this.ready = false;
            const error = new Error(`The model process exited with ${signal ?? `code ${code}`}`);
            this.readyReject?.(error);
            if (this.stopped) {
                return;
            }
            this.onLog(`[model] ${error.message}, restarting it in ${RESTART_DELAY_MS / 1000}s`);
            setTimeout(() => {
                if (!this.stopped) {
                    this.launch();
                    void this.waitUntilServing();
                }
            }, RESTART_DELAY_MS).unref();
        });
    }

    /** Polls until the server reports itself healthy, then measures what an image costs in tokens. */
    private async waitUntilServing() {
        const deadline = Date.now() + READY_TIMEOUT_MS;
        while (!this.stopped && Date.now() < deadline) {
            try {
                const response = await fetch(`http://${HOST}:${PORT}/health`);
                if (response.ok) {
                    this.ready = true;
                    this.imageTokens = await this.measureImageTokens();
                    const resolve = this.readyResolve;
                    this.readyResolve = undefined;
                    this.readyReject = undefined;
                    if (resolve) {
                        resolve(this.imageTokens);
                    } else {
                        this.onLog(`[model] ready again after restarting`);
                    }
                    return;
                }
            } catch {
                // Not listening yet. Weights this size take a while to reach the card.
            }
            await new Promise(resolve => setTimeout(resolve, HEALTH_POLL_MS));
        }
    }

    /**
     * A warm up question against a blank frame, which both compiles the kernels before the first real
     * request pays for them and shows how much of the prompt an image accounts for.
     */
    private async measureImageTokens(): Promise<number> {
        const probe = "Describe this image.";
        const budget = imageBudget();
        const blank: RgbImage = {
            width: budget.width,
            height: budget.height,
            rgb: Buffer.alloc(budget.width * budget.height * 3, 0x40),
        };
        try {
            const withImage = await this.request(blank, probe, 1);
            const textTokens = await this.countTokens(probe);
            return Math.max(0, (withImage.timings?.prompt_n ?? 0) - textTokens);
        } catch (error) {
            this.onLog(`[model] could not measure the image token cost: ${(error as Error).message}`);
            return 0;
        }
    }

    private async countTokens(text: string): Promise<number> {
        const response = await fetch(`http://${HOST}:${PORT}/tokenize`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: text }),
        });
        const body = await response.json() as { tokens?: unknown[] };
        return body.tokens?.length ?? 0;
    }

    private async request(image: RgbImage, prompt: string, maxNewTokens: number): Promise<ChatResponse> {
        const budget = imageBudget();
        const scaled = resizeToFit(image, budget.width, budget.height);
        const jpeg = encodeJpeg(scaled.rgb, scaled.width, scaled.height);
        const response = await fetch(`http://${HOST}:${PORT}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            body: JSON.stringify({
                messages: [{
                    role: "user",
                    content: [
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${jpeg.toString("base64")}` } },
                        { type: "text", text: prompt },
                    ],
                }],
                max_tokens: maxNewTokens,
                // A camera answer is a reading of what is there, so nothing is left to chance.
                temperature: 0,
                stream: false,
            }),
        });
        const body = await response.json() as ChatResponse;
        if (!response.ok || body.error) {
            throw new Error(body.error?.message ?? `The model returned ${response.status}`);
        }
        return body;
    }

    get busy(): boolean {
        return this.pending;
    }

    async ask(image: RgbImage, prompt: string, maxNewTokens = DEFAULT_MAX_NEW_TOKENS): Promise<AskResult> {
        if (this.pending) {
            throw new Error(`Expected only one question in flight at a time`);
        }
        if (!this.ready) {
            throw new Error(`The model is not running right now (restarting after a crash, or still loading)`);
        }
        this.pending = true;
        const startedAtMs = Date.now();
        try {
            const body = await this.request(image, prompt, maxNewTokens);
            this.consecutiveFailures = 0;
            const timings = body.timings ?? {};
            const prefillMs = timings.prompt_ms ?? 0;
            const generateMs = timings.predicted_ms ?? 0;
            // llama.cpp bills encoding the image inside the prefill it reports and does not break the
            // two apart anywhere a caller can read, so the whole cost is reported as prefill and the
            // vision line is left at zero rather than invented. Measured separately, the encoder is
            // most of it: prefill of an 878 token image runs near 900 tok/s against 2200 tok/s for
            // the same length of plain text, which puts the encoder at roughly 570ms of a 970ms frame.
            return {
                answer: (body.choices?.[0]?.message?.content ?? "").trim(),
                visionMs: 0,
                prefillMs,
                generateMs,
                modelMs: prefillMs + generateMs,
                promptTokens: timings.prompt_n ?? 0,
                outputTokens: timings.predicted_n ?? 0,
                roundTripMs: Date.now() - startedAtMs,
            };
        } catch (error) {
            // A server that has stopped answering will not start again on its own, and it keeps
            // passing /health while it does it, so the count is what decides rather than the check.
            this.consecutiveFailures++;
            if (this.consecutiveFailures >= FAILURES_BEFORE_RESTART) {
                this.onLog(`[model] ${this.consecutiveFailures} requests in a row went nowhere, restarting the server`);
                this.consecutiveFailures = 0;
                this.ready = false;
                this.killChild();
            }
            throw error;
        } finally {
            this.pending = false;
        }
    }

    /** Asks it to go, then makes it go. See KILL_GRACE_MS for why asking is not enough. */
    private killChild() {
        const child = this.child;
        if (!child) {
            return;
        }
        child.kill("SIGTERM");
        setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
                this.onLog(`[model] it did not stop when asked, killing it`);
                child.kill("SIGKILL");
            }
        }, KILL_GRACE_MS).unref();
    }

    stop() {
        this.stopped = true;
        this.killChild();
    }
}
