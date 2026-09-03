import * as path from "path";
import { spawn } from "child_process";

const SCRIPT = path.join(__dirname, "media.ps1");
const POWERSHELL = "powershell.exe";
// App ids cannot contain newlines, so they survive being passed as one argument.
const APP_ID_SEPARATOR = "\n";

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

function runScript(action: "status" | "pause" | "play", appIds: string[]): Promise<MediaChange> {
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, "-Action", action];
    if (appIds.length > 0) {
        args.push("-AppIds", appIds.join(APP_ID_SEPARATOR));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(POWERSHELL, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", code => {
            if (code !== 0) {
                reject(new Error(`${POWERSHELL} ${action} exited with ${code}: ${stderr.trim() || stdout.trim()}`));
                return;
            }
            const parsed = JSON.parse(stdout || `{}`) as Partial<MediaChange>;
            resolve({ changed: parsed.changed || [], skipped: parsed.skipped || [], sessions: parsed.sessions || [] });
        });
    });
}

/** Lists the media sessions Windows knows about, without touching any of them. */
export function listMediaSessions(): Promise<MediaSession[]> {
    return runScript("status", []).then(result => result.sessions);
}

/** Pauses every session that is currently playing, and reports which ones were actually paused. */
export function pausePlayingMedia(): Promise<MediaChange> {
    return runScript("pause", []);
}

/** Resumes only the given sessions, and only those still paused, so nothing we did not pause gets started. */
export function resumeMedia(appIds: string[]): Promise<MediaChange> {
    if (appIds.length === 0) {
        return Promise.resolve({ changed: [], skipped: [], sessions: [] });
    }
    return runScript("play", appIds);
}
