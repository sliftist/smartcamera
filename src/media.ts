import * as path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

/**
 * Pausing and resuming whatever Windows is playing.
 *
 * One powershell process is kept running and fed commands, rather than started per command. Starting
 * it is almost all of the cost: powershell itself, the WindowsRuntime interop assembly, the WinRT type
 * projections and the handshake with the session manager add up to seconds, and every one of those
 * seconds landed between the model deciding the headphones were off and the music actually stopping.
 * Sending a line to a process that is already up is immediate, and the room the model is watching is
 * only about a second behind reality, so this was the whole of the lag that was left.
 */

const SCRIPT = path.join(__dirname, "media.ps1");
const POWERSHELL = "powershell.exe";
const COMMAND_TIMEOUT_MS = 30 * 1000;

export type MediaSession = {
    appId: string;
    /** "Playing", "Paused", "Stopped", "Closed" or "Changing". */
    status: string;
};

export type MediaChange = {
    /** Sessions whose playback state this call actually changed. */
    changed: string[];
    /** Sessions that were already in the target state, so were left alone. */
    skipped: string[];
    sessions: MediaSession[];
    /** Sessions that errored when touched, with the reason. A dead app does not stop the others being paused. */
    failed: string[];
    /** Set when the host could not be asked at all. Nothing was changed. */
    error?: string;
};

type Reply = { id?: number; ready?: boolean; warning?: string; error?: string } & Partial<MediaChange>;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class MediaHost {
    private child: ChildProcessWithoutNullStreams | undefined;
    private ready: Promise<void> | undefined;
    private pending = new Map<number, Pending>();
    private buffer = "";
    private nextId = 1;
    private stderr = "";
    private startedAtMs = 0;

    async send(action: "status" | "pause" | "play", appIds: string[]): Promise<MediaChange> {
        try {
            return await this.sendOrThrow(action, appIds);
        } catch (error) {
            return { changed: [], skipped: [], failed: [], sessions: [], error: String((error as Error).stack ?? error) };
        }
    }

    private async sendOrThrow(action: "status" | "pause" | "play", appIds: string[]): Promise<MediaChange> {
        await this.start();
        const child = this.child;
        if (!child) {
            throw new Error(`${POWERSHELL} is not running${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`);
        }
        const id = this.nextId++;
        const reply = await new Promise<Reply>((resolve, reject) => {
            const timer = setTimeout(
                () => this.settle(id, undefined, new Error(`${POWERSHELL} did not answer ${action} within ${COMMAND_TIMEOUT_MS / 1000}s`)),
                COMMAND_TIMEOUT_MS);
            this.pending.set(id, { resolve, reject, timer });
            child.stdin.write(`${JSON.stringify({ id, action, appIds })}\n`);
        });
        if (reply.error) {
            throw new Error(`${POWERSHELL} ${action} failed: ${reply.error}`);
        }
        return { changed: reply.changed ?? [], skipped: reply.skipped ?? [], failed: reply.failed ?? [], sessions: reply.sessions ?? [] };
    }

    private start(): Promise<void> {
        if (this.ready) {
            return this.ready;
        }
        const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
            { stdio: ["pipe", "pipe", "pipe"] });
        this.child = child;
        this.startedAtMs = Date.now();
        this.stderr = "";
        this.buffer = "";
        console.log(`[media] started ${POWERSHELL} pid ${child.pid}`);

        this.ready = new Promise<void>(resolve => {
            let resolved = false;
            const finish = () => {
                if (resolved) {
                    return;
                }
                resolved = true;
                resolve();
            };
            this.onReady = finish;
            child.stdout.on("data", chunk => this.receive(String(chunk)));
            child.stderr.on("data", chunk => {
                this.stderr += String(chunk);
            });
            child.on("error", error => {
                console.error(`[media] ${POWERSHELL} could not be started:`, error.stack ?? error);
                this.died(error);
                finish();
            });
            child.on("close", code => {
                const error = new Error(`${POWERSHELL} pid ${child.pid} exited with ${code} after ${Math.round((Date.now() - this.startedAtMs) / 1000)}s${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`);
                console.error(`[media] ${error.message}`);
                this.died(error);
                finish();
            });
        });
        return this.ready;
    }

    private onReady: (() => void) | undefined;

    private died(error: Error) {
        if (this.child === undefined) {
            return;
        }
        this.child = undefined;
        this.ready = undefined;
        this.onReady = undefined;
        for (const [id] of [...this.pending]) {
            this.settle(id, undefined, error);
        }
    }

    private receive(chunk: string) {
        this.buffer += chunk;
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            newline = this.buffer.indexOf("\n");
            if (!line) {
                continue;
            }
            let reply: Reply;
            try {
                reply = JSON.parse(line) as Reply;
            } catch {
                // Not ours. Powershell writes the odd banner or warning to stdout and it is not worth
                // failing a pause over.
                continue;
            }
            if (reply.ready) {
                if (reply.warning) {
                    console.log(`[media] ${reply.warning}`);
                }
                this.onReady?.();
                this.onReady = undefined;
                continue;
            }
            this.settle(Number(reply.id), reply, undefined);
        }
    }

    private settle(id: number, reply: Reply | undefined, error: Error | undefined) {
        const waiting = this.pending.get(id);
        if (!waiting) {
            return;
        }
        this.pending.delete(id);
        clearTimeout(waiting.timer);
        if (error) {
            waiting.reject(error);
        } else if (reply) {
            waiting.resolve(reply);
        }
    }

}

const host = new MediaHost();

/** Lists the media sessions Windows knows about, without touching any of them. */
export function listMediaSessions(): Promise<MediaChange> {
    return host.send("status", []);
}

/** Pauses every session that is currently playing, and reports which ones were actually paused. */
export function pausePlayingMedia(): Promise<MediaChange> {
    return host.send("pause", []);
}

/** Resumes only the given sessions, and only those still paused, so nothing we did not pause gets started. */
export function resumeMedia(appIds: string[]): Promise<MediaChange> {
    if (appIds.length === 0) {
        return Promise.resolve({ changed: [], skipped: [], failed: [], sessions: [] });
    }
    return host.send("play", appIds);
}
