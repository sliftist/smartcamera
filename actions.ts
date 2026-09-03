import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { dayStamp, millisecondStamp } from "./src/timestamps";
import { buildPrompt, letterFor, parseRound, remember, DEFAULT_VOCABULARY_SIZE } from "./src/actionVocabulary";

const EYE2_URL = "http://127.0.0.1:8770";
const PORT = 8772;
/** Bound wide on purpose: this is meant to be read from a phone on the same network. */
const HOST = "0.0.0.0";
const DEFAULT_INTERVAL_SECONDS = 3;
const DEFAULT_INDEX = 0;
const LOG_DIRECTORY = path.join(__dirname, "actions");
const FRAME_DIRECTORY = path.join(LOG_DIRECTORY, "frames");
/** Kept in memory for the page and the recent feed; the day files on disk hold everything. */
const RECENT_LIMIT = 500;
/** eye2 writes its debug frame after the answer, so it is worth waiting a beat before copying it. */
const FRAME_WAIT_MS = 2000;
const FRAME_POLL_MS = 100;
const REQUEST_TIMEOUT_MS = 60_000;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

type Entry = {
    at: number;
    actions: string[];
    added: string[];
    /** Exactly what the model said, so a parsing decision can always be second guessed later. */
    raw: string;
    promptTokens: number;
    outputTokens: number;
    analyzeMs: number;
    /** Only kept when something new appeared; a frame per round would be gigabytes a day. */
    frame?: string;
};

class Recorder {
    private vocabulary: string[] = [];
    private recent: Entry[] = [];
    private day = "";
    private stream: fs.WriteStream | undefined;
    rounds = 0;
    failures = 0;

    constructor(private index: number, private vocabularySize: number) {
        fs.mkdirSync(FRAME_DIRECTORY, { recursive: true });
        this.loadToday();
    }

    /** Restarting mid day must not start the vocabulary or the page from nothing. */
    private loadToday() {
        const file = path.join(LOG_DIRECTORY, `${dayStamp(Date.now())}.jsonl`);
        if (!fs.existsSync(file)) {
            return;
        }
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim());
        for (const line of lines) {
            try {
                const entry = JSON.parse(line) as Entry;
                this.recent.push(entry);
                this.vocabulary = remember(this.vocabulary, entry.actions, this.vocabularySize);
            } catch {
                // A half written last line is expected after a hard stop, and is not worth a complaint.
            }
        }
        this.recent = this.recent.slice(-RECENT_LIMIT);
        log(`recovered ${lines.length} rounds from today, vocabulary is ${this.vocabulary.length} deep`);
    }

    private append(entry: Entry) {
        const today = dayStamp(entry.at);
        if (today !== this.day) {
            this.stream?.end();
            this.stream = fs.createWriteStream(path.join(LOG_DIRECTORY, `${today}.jsonl`), { flags: "a" });
            this.day = today;
        }
        this.stream?.write(JSON.stringify(entry) + "\n");
        this.recent.push(entry);
        if (this.recent.length > RECENT_LIMIT) {
            this.recent.shift();
        }
    }

    private async keepFrame(frameFile: string, at: number): Promise<string | undefined> {
        const deadline = Date.now() + FRAME_WAIT_MS;
        while (Date.now() < deadline) {
            if (fs.existsSync(frameFile) && fs.statSync(frameFile).size > 0) {
                const name = `${millisecondStamp(at)}.jpg`;
                fs.copyFileSync(frameFile, path.join(FRAME_DIRECTORY, name));
                return name;
            }
            await new Promise(resolve => setTimeout(resolve, FRAME_POLL_MS));
        }
        return undefined;
    }

    async round() {
        const prompt = buildPrompt(this.vocabulary);
        const at = Date.now();
        let reply: Record<string, unknown>;
        try {
            const response = await fetch(EYE2_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ index: String(this.index), prompt }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            reply = await response.json() as Record<string, unknown>;
        } catch (error) {
            this.failures++;
            log(`asking failed: ${(error as Error).message}`);
            return;
        }
        if (typeof reply.error === "string") {
            this.failures++;
            log(`eye2 refused: ${reply.error}`);
            return;
        }

        const raw = String(reply.answer ?? "");
        const { actions, added } = parseRound(raw, this.vocabulary);
        const entry: Entry = {
            at,
            actions,
            added,
            raw,
            promptTokens: Number(reply.promptTokens ?? 0),
            outputTokens: Number(reply.outputTokens ?? 0),
            analyzeMs: Number(reply.analyzeMs ?? 0),
        };
        if (added.length > 0 && typeof reply.frameFile === "string") {
            entry.frame = await this.keepFrame(reply.frameFile, at);
        }
        this.vocabulary = remember(this.vocabulary, actions, this.vocabularySize);
        this.append(entry);
        this.rounds++;

        const shown = actions.map(action => added.includes(action) ? `NEW ${action}` : action);
        log(`${entry.outputTokens} out tok, ${entry.analyzeMs.toFixed(0)}ms | ${shown.join(" | ") || "(nothing)"}`);
    }

    get state() {
        return {
            rounds: this.rounds,
            failures: this.failures,
            vocabulary: this.vocabulary.map((action, index) => ({ letter: letterFor(index), action })),
        };
    }

    entriesSince(since: number, limit: number): Entry[] {
        return this.recent.filter(entry => entry.at > since).slice(-limit);
    }
}

function escapeHtml(text: string): string {
    return text.replace(/[&<>"]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[character] as string));
}

function page(recorder: Recorder): string {
    const entries = [...recorder.entriesSince(0, 200)].reverse();
    const state = recorder.state;
    const rows = entries.map(entry => {
        const actions = entry.actions.map(action =>
            `<span class="${entry.added.includes(action) ? "action new" : "action"}">${escapeHtml(action)}</span>`).join("");
        const frame = entry.frame ? `<a href="/frames/${encodeURIComponent(entry.frame)}"><img src="/frames/${encodeURIComponent(entry.frame)}"></a>` : "";
        return `<tr><td class="time">${formatDateTime(entry.at)}</td><td>${actions || "<span class=quiet>nothing</span>"}${frame}</td><td class="cost">${entry.outputTokens} tok<br>${entry.analyzeMs.toFixed(0)} ms</td></tr>`;
    }).join("");
    const vocabulary = state.vocabulary.map(item => `<li><b>${item.letter}</b> ${escapeHtml(item.action)}</li>`).join("");
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>eye actions</title>
<style>
:root { color-scheme: light dark; --line: #8884; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { opacity: .7; margin-bottom: 16px; }
table { border-collapse: collapse; width: 100%; }
td { border-top: 1px solid var(--line); padding: 8px 6px; vertical-align: top; }
.time { white-space: nowrap; opacity: .7; width: 1%; }
.cost { white-space: nowrap; opacity: .55; text-align: right; width: 1%; }
.action { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; margin: 2px 4px 2px 0; }
.action.new { border-color: #d9822b; color: #d9822b; font-weight: 600; }
.quiet { opacity: .5; }
img { display: block; margin-top: 8px; max-width: 380px; width: 100%; border-radius: 6px; }
ul { list-style: none; padding: 0; margin: 0 0 16px; columns: 2; }
li { break-inside: avoid; }
</style>
<h1>eye actions</h1>
<div class="meta">${state.rounds} rounds, ${state.failures} failed. Refreshes every 5s. Orange means the model had no letter for it yet.</div>
<ul>${vocabulary || "<li class=quiet>no vocabulary yet</li>"}</ul>
<table>${rows}</table>
<script>setTimeout(() => location.reload(), 5000);</script>`;
}

async function main() {
    const args = process.argv.slice(2);
    let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    let index = DEFAULT_INDEX;
    let vocabularySize = DEFAULT_VOCABULARY_SIZE;
    for (let position = 0; position < args.length; position++) {
        if (args[position] === "--every") {
            intervalSeconds = Number(args[++position]);
        } else if (args[position] === "--index") {
            index = Number(args[++position]);
        } else if (args[position] === "--vocabulary") {
            vocabularySize = Number(args[++position]);
        } else {
            console.error(`Unknown argument ${args[position]}; known are --every, --index, --vocabulary`);
            process.exit(1);
        }
    }

    const recorder = new Recorder(index, vocabularySize);

    const server = http.createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
            if (url.pathname === "/log") {
                const since = Number(url.searchParams.get("since") ?? 0);
                const limit = Number(url.searchParams.get("limit") ?? 200);
                const body = JSON.stringify(recorder.entriesSince(since, limit));
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(body);
                return;
            }
            if (url.pathname === "/status") {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(recorder.state));
                return;
            }
            if (url.pathname.startsWith("/frames/")) {
                // Resolved and then checked, so a crafted name cannot walk out of the frame directory.
                const name = path.basename(decodeURIComponent(url.pathname.slice("/frames/".length)));
                const file = path.join(FRAME_DIRECTORY, name);
                if (!file.startsWith(FRAME_DIRECTORY) || !fs.existsSync(file)) {
                    response.writeHead(404).end("no such frame");
                    return;
                }
                response.writeHead(200, { "Content-Type": "image/jpeg" });
                fs.createReadStream(file).pipe(response);
                return;
            }
            if (url.pathname === "/") {
                response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                response.end(page(recorder));
                return;
            }
            response.writeHead(404).end("not found");
        })();
    });

    server.listen(PORT, HOST, () => {
        log(`serving the action log on http://${HOST}:${PORT}`);
        log(`  /        the page`);
        log(`  /log     json, ?since=<ms epoch>&limit=<n>`);
        log(`  /status  rounds and the current vocabulary`);
    });

    log(`asking camera ${index} every ${intervalSeconds}s, keeping ${vocabularySize} lettered actions`);
    while (true) {
        const startedAtMs = Date.now();
        await recorder.round();
        const remainingMs = intervalSeconds * 1000 - (Date.now() - startedAtMs);
        if (remainingMs > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingMs));
        }
    }
}

main().catch(error => {
    console.error(`[actions] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
