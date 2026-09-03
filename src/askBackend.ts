import { RgbImage } from "./yolo";
import { AskClient, AskResult } from "./askClient";
import { LlamaAskClient } from "./askLlama";

/** What eye2 needs from a model, whichever accelerator is actually underneath it. */
export type AskBackend = {
    start(): Promise<number>;
    ask(image: RgbImage, prompt: string, maxNewTokens?: number, budget?: { width: number; height: number }): Promise<AskResult>;
    stop(): void;
    readonly busy: boolean;
};

export type BackendName = "llama" | "tensorrt";

/**
 * TensorRT is nvidia only, so it cannot be the default on a machine picked for an amd card. The
 * llama.cpp backend runs the same model over rocm and answers with the same shape, which is why the
 * choice can live here rather than anywhere that cares what the answer means.
 */
export function createAskBackend(repoRoot: string, onLog: (message: string) => void): { backend: AskBackend; name: BackendName } {
    const requested = (process.env.SMARTCAMERA_BACKEND || "llama").toLowerCase();
    if (requested === "tensorrt") {
        return { backend: new AskClient(repoRoot, onLog), name: "tensorrt" };
    }
    if (requested !== "llama") {
        throw new Error(`Unknown SMARTCAMERA_BACKEND ${JSON.stringify(requested)}, expected llama or tensorrt`);
    }
    return { backend: new LlamaAskClient(repoRoot, onLog), name: "llama" };
}
