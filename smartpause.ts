import { formatDateTime } from "socket-function/src/formatting/format";
import { pausePlayingMedia, resumeMedia } from "./src/media";

const EYE2_URL = "http://127.0.0.1:8770/";
const VIEW_INDEX = 1;
const PROMPT = "Does the person in the image have headphones on? Yes or no. No explanation. No preamble.";
const RETRY_DELAY_MS = 10 * 1000;
const DEFAULT_PAUSE_AFTER = 2;
/** How long to wait before asking Windows again once it said nothing was playing. */
const RETRY_PAUSE_MS = 30 * 1000;
const COUNT_PATTERN = /^\d+$/;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Undefined for anything that is not clearly a yes or a no, which must not move the counters. */
function parseAnswer(answer: string): boolean | undefined {
    const cleaned = answer.trim().toLowerCase().replace(/[^a-z ]/g, "");
    if (cleaned.startsWith("yes")) {
        return true;
    }
    if (cleaned.startsWith("no")) {
        return false;
    }
    return undefined;
}

type Reply = { answer?: string; error?: string; analyzeMs?: number; decodeMs?: number };

async function askEye2(): Promise<Reply> {
    const response = await fetch(EYE2_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: VIEW_INDEX, prompt: PROMPT }),
    });
    const reply = await response.json() as Reply;
    if (!response.ok) {
        throw new Error(reply.error || `eye2 replied ${response.status}`);
    }
    return reply;
}

class Watcher {
    /** Non empty exactly when we are the reason something is paused. */
    private pausedSessions: string[] = [];
    private missingRun = 0;
    private nothingPlayingAtMs = 0;

    constructor(private pauseAfter: number) { }

    async onAnswer(wearing: boolean) {
        this.missingRun = wearing ? 0 : this.missingRun + 1;

        if (this.pausedSessions.length > 0) {
            // Coming back only ever takes one answer: waiting to resume is what would be annoying.
            if (!wearing) {
                return;
            }
            const result = await resumeMedia(this.pausedSessions);
            const skipped = result.skipped.length > 0 ? `, left ${result.skipped.join(", ")} alone because something else changed it` : "";
            log(`playing: headphones back on, resumed ${result.changed.join(", ") || "nothing"}${skipped}`);
            this.pausedSessions = [];
            this.nothingPlayingAtMs = 0;
            return;
        }

        if (wearing) {
            this.nothingPlayingAtMs = 0;
            return;
        }
        if (this.missingRun < this.pauseAfter) {
            return;
        }
        // Windows already told us there was nothing to pause, so give it a while before asking again
        // rather than spawning powershell every couple of seconds for the same answer.
        if (this.nothingPlayingAtMs && Date.now() - this.nothingPlayingAtMs < RETRY_PAUSE_MS) {
            return;
        }
        const result = await pausePlayingMedia();
        if (result.changed.length === 0) {
            if (!this.nothingPlayingAtMs) {
                log(`nothing to pause: no headphones for ${this.missingRun} answers, and nothing was playing`);
            }
            this.nothingPlayingAtMs = Date.now();
            return;
        }
        this.pausedSessions = result.changed;
        this.nothingPlayingAtMs = 0;
        log(`paused: no headphones for ${this.missingRun} answers, paused ${result.changed.join(", ")}`);
    }
}

function parsePauseAfter(argv: string[]): number {
    for (const raw of argv) {
        const argument = raw.replace(/^--?/, "");
        if (!COUNT_PATTERN.test(argument)) {
            continue;
        }
        const count = parseInt(argument, 10);
        if (count < 1) {
            console.error(`[smartpause] the pause count must be at least 1, got ${argument}`);
            process.exit(1);
        }
        return count;
    }
    return DEFAULT_PAUSE_AFTER;
}

async function main() {
    const pauseAfter = parsePauseAfter(process.argv.slice(2));
    console.log(`[smartpause] asking eye2 view ${VIEW_INDEX} back to back, with no wait between answers:`);
    console.log(`[smartpause]   "${PROMPT}"`);
    console.log(`[smartpause] ${pauseAfter} "no" answer${pauseAfter === 1 ? "" : "s"} in a row pauses, one "yes" resumes`);

    const watcher = new Watcher(pauseAfter);
    let lastAnswer = "";
    while (true) {
        try {
            const reply = await askEye2();
            const answer = reply.answer ?? "";
            const wearing = parseAnswer(answer);
            if (wearing === undefined) {
                log(`ignoring an answer that is neither yes nor no: ${JSON.stringify(answer)}`);
            } else {
                if (answer !== lastAnswer) {
                    log(`headphones: ${wearing ? "yes" : "no"} (${answer})`);
                    lastAnswer = answer;
                }
                await watcher.onAnswer(wearing);
            }
        } catch (error) {
            log(`eye2 is not answering, retrying in ${RETRY_DELAY_MS / 1000}s: ${(error as Error).message}`);
            await delay(RETRY_DELAY_MS);
        }
    }
}

main().catch(error => {
    console.error(`[smartpause] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
