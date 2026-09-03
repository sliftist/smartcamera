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
/** Long enough for a cold start on a busy machine, short enough that a wedged host does not hang. */
const STARTUP_TIMEOUT_MS = 30 * 1000;
/** The expensive part is already done by the time a command is sent, so this only catches a hang. */
const COMMAND_TIMEOUT_MS = 15 * 1000;

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
};

type Reply = { id?: number; ready?: boolean; error?: string } & Partial<MediaChange>;
type Pending = { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/**
 * The running powershell, started on the first command and restarted if it dies.
 *
 * Commands are tagged with a number and matched to the reply carrying it, rather than assumed to come
 * back in order. Nothing here sends two at once today, but a host that answered the wrong caller would
 * pause the wrong app, and that is a bad thing to find out about later.
 */
class MediaHost {
    private child: ChildProcessWithoutNullStreams | undefined;
    private starting: Promise<void> | undefined;
    private pending = new Map<number, Pending>();
    private ready: (() => void) | undefined;
    private buffer = "";
    private nextId = 1;

    async send(action: "status" | "pause" | "play", appIds: string[]): Promise<MediaChange> {
        await this.start();
        const child = this.child;
        if (!child) {
            throw new Error(`${POWERSHELL} is not running`);
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
        return { changed: reply.changed ?? [], skipped: reply.skipped ?? [], sessions: reply.sessions ?? [] };
    }

    private start(): Promise<void> {
        if (this.child) {
            return Promise.resolve();
        }
        if (this.starting) {
            return this.starting;
        }
        this.starting = new Promise<void>((resolve, reject) => {
            const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
                { stdio: ["pipe", "pipe", "pipe"] });
            this.child = child;
            let stderr = "";

            const failed = (error: Error) => {
                this.stop(error);
                reject(error);
            };
            const timer = setTimeout(
                () => failed(new Error(`${POWERSHELL} did not start within ${STARTUP_TIMEOUT_MS / 1000}s${stderr.trim() ? `: ${stderr.trim()}` : ""}`)),
                STARTUP_TIMEOUT_MS);
            // The host says so once the WinRT setup is behind it, so the first pause is not the one
            // that waits for all of it.
            this.ready = () => {
                clearTimeout(timer);
                this.ready = undefined;
                resolve();
            };

            child.stdout.on("data", chunk => this.receive(String(chunk)));
            child.stderr.on("data", chunk => {
                stderr += String(chunk);
            });
            child.on("error", error => failed(error as Error));
            child.on("close", code => {
                clearTimeout(timer);
                // Whatever it was doing is lost, and the next call starts a fresh one. Reported rather
                // than retried here, so a host that dies on every command does not spin forever.
                failed(new Error(`${POWERSHELL} exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
            });
        }).finally(() => {
            this.starting = undefined;
        });
        return this.starting;
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
                this.ready?.();
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

    private stop(error: Error) {
        const child = this.child;
        this.child = undefined;
        this.ready = undefined;
        this.buffer = "";
        child?.kill();
        for (const [id] of [...this.pending]) {
            this.settle(id, undefined, error);
        }
    }
}

const host = new MediaHost();

/** Lists the media sessions Windows knows about, without touching any of them. */
export function listMediaSessions(): Promise<MediaSession[]> {
    return host.send("status", []).then(result => result.sessions);
}

/** Pauses every session that is currently playing, and reports which ones were actually paused. */
export function pausePlayingMedia(): Promise<MediaChange> {
    return host.send("pause", []);
}

/** Resumes only the given sessions, and only those still paused, so nothing we did not pause gets started. */
export function resumeMedia(appIds: string[]): Promise<MediaChange> {
    if (appIds.length === 0) {
        return Promise.resolve({ changed: [], skipped: [], sessions: [] });
    }
    return host.send("play", appIds);
}
