import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { RgbImage } from "./yolo";

const READY_TIMEOUT_MS = 300_000;
const RESTART_DELAY_MS = 5_000;
const FRAME_FILE = path.join(os.tmpdir(), "smartcamera-ask-frame.rgb");

export type AskTimings = {
    visionMs: number;
    prefillMs: number;
    generateMs: number;
    modelMs: number;
    promptTokens: number;
    outputTokens: number;
};

/** roundTripMs covers modelMs plus handing the frame over, so the difference is the overhead. */
export type AskResult = AskTimings & { answer: string; roundTripMs: number };

type Pending = {
    resolve: (result: AskResult) => void;
    reject: (error: Error) => void;
};

export class AskClient {
    private child: ChildProcess | undefined;
    private pending: Pending | undefined;
    private buffer = "";
    private readyResolve: ((tokens: number) => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;

    private ready = false;
    private stopped = false;

    constructor(private repoRoot: string, private onLog: (message: string) => void) { }

    start(): Promise<number> {
        this.launch();
        return new Promise<number>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
            setTimeout(() => reject(new Error(`The model did not become ready within ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS).unref();
        });
    }

    private launch() {
        const child = spawn(
            "python",
            ["-m", "uv", "--project", "python", "run", "python", "-u", "python/askServer.py"],
            { cwd: this.repoRoot, stdio: ["pipe", "pipe", "pipe"] },
        );
        this.child = child;
        this.ready = false;
        this.buffer = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => this.onStdout(chunk));
        child.stderr.on("data", chunk => {
            for (const line of String(chunk).split(/\r?\n/)) {
                if (line.trim()) {
                    this.onLog(`[model] ${line.trim()}`);
                }
            }
        });
        // Without these, the pipe breaking would raise an error event nobody listens to, and an
        // unlistened stream error kills the whole process with no stack.
        child.stdin.on("error", error => this.onLog(`[model] stdin failed: ${(error as Error).message}`));
        child.stdout.on("error", error => this.onLog(`[model] stdout failed: ${(error as Error).message}`));
        child.on("error", error => this.onLog(`[model] could not be spawned: ${(error as Error).message}`));
        child.on("exit", (code, signal) => {
            this.ready = false;
            const error = new Error(`The model process exited with ${signal ?? `code ${code}`}`);
            this.readyReject?.(error);
            this.pending?.reject(error);
            this.pending = undefined;
            if (this.stopped) {
                return;
            }
            this.onLog(`[model] ${error.message}, restarting it in ${RESTART_DELAY_MS / 1000}s`);
            setTimeout(() => {
                if (!this.stopped) {
                    this.launch();
                }
            }, RESTART_DELAY_MS).unref();
        });
    }

    private onStdout(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) {
                continue;
            }
            let message: Record<string, unknown>;
            try {
                message = JSON.parse(line);
            } catch {
                this.onLog(`[model] ${line}`);
                continue;
            }
            if (message.ready) {
                this.ready = true;
                const resolve = this.readyResolve;
                this.readyResolve = undefined;
                this.readyReject = undefined;
                if (resolve) {
                    resolve(Number(message.imageTokens ?? 0));
                } else {
                    this.onLog(`[model] ready again after restarting`);
                }
                continue;
            }
            const pending = this.pending;
            this.pending = undefined;
            if (!pending) {
                continue;
            }
            if (typeof message.error === "string") {
                pending.reject(new Error(message.error));
            } else {
                pending.resolve(message as unknown as AskResult);
            }
        }
    }

    get busy(): boolean {
        return this.pending !== undefined;
    }

    async ask(image: RgbImage, prompt: string): Promise<AskResult> {
        if (this.pending) {
            throw new Error(`Expected only one question in flight at a time`);
        }
        if (!this.ready) {
            throw new Error(`The model is not running right now (restarting after a crash, or still loading)`);
        }
        const startedAtMs = Date.now();
        await fs.promises.writeFile(FRAME_FILE, image.rgb);
        const request = JSON.stringify({ file: FRAME_FILE, width: image.width, height: image.height, prompt });
        const result = await new Promise<AskResult>((resolve, reject) => {
            this.pending = { resolve, reject };
            try {
                this.child?.stdin?.write(request + "\n");
            } catch (error) {
                this.pending = undefined;
                reject(error as Error);
            }
        });
        return { ...result, roundTripMs: Date.now() - startedAtMs };
    }

    stop() {
        this.stopped = true;
        this.child?.kill();
    }
}
