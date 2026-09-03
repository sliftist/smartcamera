import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { pausePlayingMedia, resumeMedia } from "./src/media";
import { EyeClient } from "./src/eyeClient";

/**
 * Pauses whatever is playing when the headphones come off, and resumes when they go back on.
 *
 * It used to poll eye2 in a loop and parse yes or no out of prose. It watches the actions service
 * now, which asks that question of every frame anyway, so this is a subscription rather than a
 * second thing hammering the model with its own copy of the same question.
 */

/** The phrase watched. Registered with the service automatically if it is not already being asked. */
const PHRASE = "wearing headphones";
/**
 * Where the password is expected. A fixed path in the home folder, matching facehuggingtoken.txt
 * beside it, so nothing has to be passed on a command line or baked into a service file.
 */
const PASSWORD_FILE = path.join(os.homedir(), "smartcamerapassword.txt");
const PASSWORD_POLL_MS = 5000;
/**
 * How long the headphones have to stay off before anything is paused. Answers land about every 1.4s,
 * so this is roughly two of them, and it exists because one bad answer should not stop your music.
 */
const PAUSE_AFTER_MS = 3000;
/** Once Windows says nothing is playing, wait before asking it again rather than spawning powershell. */
const RETRY_PAUSE_MS = 30 * 1000;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

/**
 * Waits for the password file, saying where it is looking each time.
 *
 * Only the final newline an editor adds is removed. Anything else, including spaces, is part of the
 * password: the service takes it exactly as written and so does this.
 */
async function readPassword(): Promise<string> {
    while (true) {
        try {
            return fs.readFileSync(PASSWORD_FILE, "utf8").replace(/\r?\n$/, "");
        } catch {
            log(`waiting for the password; expecting it at ${PASSWORD_FILE}`);
            await new Promise(resolve => setTimeout(resolve, PASSWORD_POLL_MS));
        }
    }
}

class Pauser {
    /** Non empty exactly when we are the reason something is paused. */
    private paused: string[] = [];
    private pending: ReturnType<typeof setTimeout> | undefined;
    private nothingPlayingAtMs = 0;

    /** The headphones came off. Nothing happens yet, in case they go back on. */
    off() {
        if (this.pending) {
            return;
        }
        this.pending = setTimeout(() => {
            this.pending = undefined;
            void this.pause();
        }, PAUSE_AFTER_MS);
    }

    /** The headphones went back on. Coming back takes effect at once: waiting is what would annoy. */
    async on() {
        if (this.pending) {
            clearTimeout(this.pending);
            this.pending = undefined;
        }
        if (this.paused.length === 0) {
            this.nothingPlayingAtMs = 0;
            return;
        }
        const result = await resumeMedia(this.paused);
        const skipped = result.skipped.length > 0
            ? `, left ${result.skipped.join(", ")} alone because something else changed it`
            : "";
        log(`headphones back on, resumed ${result.changed.join(", ") || "nothing"}${skipped}`);
        this.paused = [];
        this.nothingPlayingAtMs = 0;
    }

    private async pause() {
        if (this.nothingPlayingAtMs && Date.now() - this.nothingPlayingAtMs < RETRY_PAUSE_MS) {
            return;
        }
        const result = await pausePlayingMedia();
        if (result.changed.length === 0) {
            if (!this.nothingPlayingAtMs) {
                log(`headphones off, but nothing was playing`);
            }
            this.nothingPlayingAtMs = Date.now();
            return;
        }
        this.paused = result.changed;
        this.nothingPlayingAtMs = 0;
        log(`headphones off, paused ${result.changed.join(", ")}`);
    }
}

function urlFrom(argv: string[]): string {
    const flag = argv.indexOf("--url");
    if (flag >= 0 && argv[flag + 1]) {
        return argv[flag + 1];
    }
    return process.env.EYE_URL || "http://127.0.0.1:8772";
}

async function main() {
    const url = urlFrom(process.argv.slice(2));
    const password = await readPassword();
    log(`watching ${JSON.stringify(PHRASE)} at ${url}`);

    const pauser = new Pauser();
    new EyeClient({
        url,
        password,
        onConnectionChange: (connected, reason) =>
            log(connected ? `connected` : `disconnected${reason ? `: ${reason}` : ""}, retrying`),
        onError: error => log(`${error.message}`),
    }).watch(PHRASE, {
        onStart: () => { void pauser.on(); },
        onStop: () => pauser.off(),
    });
}

main().catch(error => {
    console.error(`[smartpause] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
