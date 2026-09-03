import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { listMediaSessions, pausePlayingMedia, resumeMedia } from "./src/media";
import { EyeClient } from "./src/eyeClient";
import { HEADPHONES_PHRASE } from "./src/questions";

/**
 * Pauses whatever is playing when the headphones come off, and resumes when they go back on.
 *
 * It used to poll eye2 in a loop and parse yes or no out of prose. It watches the actions service
 * now, which asks that question of every frame anyway, so this is a subscription rather than a
 * second thing hammering the model with its own copy of the same question.
 */

/**
 * One of the service defaults, rather than a phrase of its own.
 *
 * Watching "wearing headphones" registered a tenth question for something already being asked as
 * "is anyone wearing headphones", so every frame answered the same thing twice, forever, for nothing.
 * Naming the default means the client registers nothing at all.
 */
const PHRASE = HEADPHONES_PHRASE;
/**
 * Where the password is expected. A fixed path in the home folder, matching facehuggingtoken.txt
 * beside it, so nothing has to be passed on a command line or baked into a service file.
 */
const PASSWORD_FILE = path.join(os.homedir(), "smartcamerapassword.txt");
const PASSWORD_POLL_MS = 5000;
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
    private nothingPlayingAtMs = 0;

    /** The headphones came off. Both directions act at once; waiting was never worth what it cost. */
    async off() {
        await this.pause();
    }

    async on() {
        if (this.paused.length === 0) {
            this.nothingPlayingAtMs = 0;
            return;
        }
        const startedAtMs = Date.now();
        const result = await resumeMedia(this.paused);
        const skipped = result.skipped.length > 0
            ? `, left ${result.skipped.join(", ")} alone because something else changed it`
            : "";
        log(`headphones back on, resumed ${result.changed.join(", ") || "nothing"}${skipped}`
            + ` in ${Date.now() - startedAtMs}ms`);
        this.paused = [];
        this.nothingPlayingAtMs = 0;
    }

    private async pause() {
        if (this.nothingPlayingAtMs && Date.now() - this.nothingPlayingAtMs < RETRY_PAUSE_MS) {
            return;
        }
        const startedAtMs = Date.now();
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
        // Timed because this is where the lag was. The model is about a second behind the room and
        // cannot be much faster, so anything on top of that shows up here.
        log(`headphones off, paused ${result.changed.join(", ")} in ${Date.now() - startedAtMs}ms`);
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

    // Started now rather than on the first pause. Standing powershell up is the expensive part, and
    // paying for it at the moment the headphones come off is exactly the wrong time.
    const startedAtMs = Date.now();
    try {
        const sessions = await listMediaSessions();
        log(`media host ready in ${Date.now() - startedAtMs}ms, ${sessions.length} session${sessions.length === 1 ? "" : "s"} open`);
    } catch (error) {
        // Not fatal. It is retried on the first pause, and saying so beats dying over a warm up.
        log(`could not start the media host: ${(error as Error).message}`);
    }
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
        onStop: () => { void pauser.off(); },
    });
}

main().catch(error => {
    console.error(`[smartpause] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
