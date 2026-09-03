import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { formatDateTime } from "socket-function/src/formatting/format";
import { dayStamp, millisecondStamp } from "./src/timestamps";
import { buildPrompt, parseRound, remember, DEFAULT_VOCABULARY_SIZE } from "./src/actionVocabulary";

const EYE2_URL = "http://127.0.0.1:8770";
const PORT = 8772;
/** Bound wide on purpose: this is meant to be read from a phone on the same network. */
const HOST = "0.0.0.0";
/**
 * Zero means ask again the moment the last answer lands. The model is the whole cost of a round at
 * about 1.5s; decoding a frame is 10ms, so there is nothing to be gained by pacing the asking.
 */
const DEFAULT_INTERVAL_SECONDS = 0;
const DEFAULT_INDEX = 0;
const LOG_DIRECTORY = path.join(__dirname, "actions");
/** Kept in memory for a new page and the feed; the day files on disk hold everything. */
const RECENT_LIMIT = 500;
/** What a joining page is shown before live rounds start arriving. */
const BACKLOG_LIMIT = 200;
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Frames are held in memory for this long and never written down unless someone annotates one. The
 * point of the log is the text; keeping every frame at this rate would be gigabytes a day. Holding a
 * short tail is what makes it possible to look back at what the model was describing and say what it
 * missed, which is the only frame worth saving.
 */
const FRAME_BUFFER_MS = 30_000;
/**
 * Frames are pulled on their own clock rather than one per answer. Tying them to rounds gave a frame
 * only every 1.4s and, worse, tied what is kept to what the model happened to be asked about.
 */
const FRAME_PULL_MS = 1000;
const TRAINING_DIRECTORY = path.join(__dirname, "training");
const MAX_NOTE_LENGTH = 500;

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
    /** Decoding the frame, which is the only part that is not the model. */
    decodeMs: number;
    /** Reading the image and the prompt, which is where nearly all of a round goes. */
    prefillMs: number;
    /** Writing the answer, which is why letters are cheaper than phrases. */
    generateMs: number;
    analyzeMs: number;
};

type BufferedFrame = {
    id: string;
    at: number;
    jpeg: Buffer;
};

type Listener = (entry: Entry) => void;

class Recorder {
    private vocabulary: string[] = [];
    private recent: Entry[] = [];
    private day = "";
    private stream: fs.WriteStream | undefined;
    private listeners = new Set<Listener>();
    private frames: BufferedFrame[] = [];
    rounds = 0;
    failures = 0;
    framesMissing = 0;

    constructor(private index: number, private vocabularySize: number) {
        fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
        fs.mkdirSync(TRAINING_DIRECTORY, { recursive: true });
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

    /**
     * Held only as bytes in memory, and only until they age out.
     *
     * Asked of eye2 directly rather than read off the debug jpegs it leaves on disk. Those are named
     * by a number that cycles, and eye2 writes one only after it has finished answering, so reading
     * the path it just handed back returns whatever was at that number a hundred rounds ago. That is
     * where the duplicates came from: not the same frame twice, but a previous lap's frames served
     * back in order.
     */
    async pullFrame() {
        const at = Date.now();
        try {
            const response = await fetch(`${EYE2_URL}/frame?index=${this.index}`, {
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`eye2 returned ${response.status}`);
            }
            const jpeg = Buffer.from(await response.arrayBuffer());
            if (jpeg.length > 0) {
                this.frames.push({ id: String(at), at, jpeg });
            }
        } catch (error) {
            this.framesMissing++;
        }
        const cutoff = Date.now() - FRAME_BUFFER_MS;
        this.frames = this.frames.filter(frame => frame.at >= cutoff);
    }

    recentFrames(): { id: string; at: number }[] {
        const cutoff = Date.now() - FRAME_BUFFER_MS;
        return this.frames.filter(frame => frame.at >= cutoff).map(frame => ({ id: frame.id, at: frame.at }));
    }

    frame(id: string): Buffer | undefined {
        return this.frames.find(candidate => candidate.id === id)?.jpeg;
    }

    /** The frame, what the model said about it, and what it missed, which is the whole training pair. */
    annotate(id: string, note: string): { saved: string } {
        const frame = this.frames.find(candidate => candidate.id === id);
        if (!frame) {
            throw new Error(`That frame has already aged out of the buffer`);
        }
        const entry = this.recent.reduce<Entry | undefined>((closest, candidate) => {
            if (!closest) {
                return candidate;
            }
            return Math.abs(candidate.at - frame.at) < Math.abs(closest.at - frame.at) ? candidate : closest;
        }, undefined);
        const stem = millisecondStamp(frame.at);
        fs.writeFileSync(path.join(TRAINING_DIRECTORY, `${stem}.jpg`), frame.jpeg);
        fs.writeFileSync(path.join(TRAINING_DIRECTORY, `${stem}.json`), JSON.stringify({
            at: frame.at,
            missing: note,
            reported: entry?.actions ?? [],
            raw: entry?.raw ?? "",
            prompt: buildPrompt(this.vocabulary),
        }, undefined, 2));
        log(`annotated ${stem}: ${JSON.stringify(note)}`);
        return { saved: `${stem}.jpg` };
    }

    listen(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
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
        for (const listener of this.listeners) {
            listener(entry);
        }
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
            decodeMs: Number(reply.decodeMs ?? 0),
            prefillMs: Number(reply.prefillMs ?? 0),
            generateMs: Number(reply.generateMs ?? 0),
            analyzeMs: Number(reply.analyzeMs ?? 0),
        };
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
            buffered: this.recentFrames().length,
            bufferSeconds: FRAME_BUFFER_MS / 1000,
            // Newest first for reading. The letters are an encoding detail between here and the model,
            // so they stay out of the page: what matters is which actions are currently remembered.
            vocabulary: [...this.vocabulary].reverse(),
            // Sent so the wording can be reviewed against the answers it is producing, live.
            prompt: buildPrompt(this.vocabulary),
        };
    }

    entriesSince(since: number, limit: number): Entry[] {
        return this.recent.filter(entry => entry.at > since).slice(-limit);
    }
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>eye actions</title>
<style>
:root { color-scheme: light dark; --line: #8884; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 16px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { opacity: .7; margin-bottom: 12px; }
#link { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #2ba84a; margin-right: 6px; }
#link.down { background: #d94b4b; }
ul { list-style: none; padding: 0; margin: 0 0 16px; columns: 2; }
li { break-inside: avoid; }
details { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; margin-bottom: 16px; }
summary { cursor: pointer; opacity: .8; }
pre { margin: 10px 0 0; white-space: pre-wrap; font: 12px/1.5 ui-monospace, monospace; opacity: .85; }
h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .55; margin: 0 0 6px; font-weight: 600; }
button { font: inherit; padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: none; color: inherit; cursor: pointer; }
button:hover { border-color: #888; }
#strip { display: flex; gap: 8px; overflow-x: auto; padding: 10px 0; }
#strip figure { margin: 0; flex: 0 0 auto; cursor: pointer; text-align: center; }
#strip img { display: block; width: 190px; border-radius: 5px; border: 2px solid transparent; }
#strip figure:hover img { border-color: #d9822b; }
#strip figcaption { font-size: 11px; opacity: .6; margin-top: 3px; }
.saved { color: #2ba84a; }
.breakdown { font-size: 11px; opacity: .55; white-space: nowrap; }
table { border-collapse: collapse; width: 100%; }
td { border-top: 1px solid var(--line); padding: 7px 6px; vertical-align: top; }
.time { white-space: nowrap; opacity: .7; width: 1%; }
.cost { white-space: nowrap; opacity: .55; text-align: right; width: 1%; }
.action { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px; margin: 2px 4px 2px 0; }
.action.new { border-color: #d9822b; color: #d9822b; font-weight: 600; }
.quiet { opacity: .5; }
/* New rounds arrive at the top, so they fade in rather than making the whole list jump. */
tr.fresh { animation: in .35s ease-out; }
@keyframes in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
</style>
<h1>eye actions</h1>
<div class="meta"><span id="link"></span><span id="stats">connecting</span></div>
<details><summary>the prompt being sent right now</summary><pre id="prompt"></pre></details>
<h2>remembered actions</h2>
<ul id="vocabulary"></ul>
<h2>frames <span id="buffered" class="quiet"></span></h2>
<div><button id="capture">capture frames</button> <span id="note" class="quiet"></span></div>
<div id="strip"></div>
<table><tbody id="rows"></tbody></table>
<script>
const rows = document.getElementById("rows");
const vocabulary = document.getElementById("vocabulary");
const stats = document.getElementById("stats");
const prompt = document.getElementById("prompt");
const buffered = document.getElementById("buffered");
const strip = document.getElementById("strip");
const note = document.getElementById("note");

async function annotate(frame) {
    const missing = window.prompt("What did the model miss in this frame?");
    if (!missing || !missing.trim()) {
        return;
    }
    const response = await fetch("/annotate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: frame.id, note: missing.trim() }),
    });
    const reply = await response.json();
    note.textContent = reply.error ? ("could not save: " + reply.error) : ("saved " + reply.saved);
    note.className = reply.error ? "quiet" : "saved";
}

document.getElementById("capture").onclick = async () => {
    const frames = await (await fetch("/frames")).json();
    strip.replaceChildren();
    note.textContent = frames.length ? "click a frame to say what was missed" : "no frames held yet";
    note.className = "quiet";
    // Newest first, matching the log above it.
    for (const frame of frames.slice().reverse()) {
        const figure = document.createElement("figure");
        const image = document.createElement("img");
        image.src = "/frames/" + encodeURIComponent(frame.id);
        image.loading = "lazy";
        const caption = document.createElement("figcaption");
        caption.textContent = time(frame.at);
        figure.append(image, caption);
        figure.onclick = () => annotate(frame);
        strip.append(figure);
    }
};
const link = document.getElementById("link");
const LIMIT = 300;

function time(at) {
    return new Date(at).toLocaleTimeString();
}

function row(entry) {
    const tr = document.createElement("tr");
    const when = document.createElement("td");
    when.className = "time";
    when.textContent = time(entry.at);
    const what = document.createElement("td");
    if (entry.actions.length === 0) {
        const none = document.createElement("span");
        none.className = "quiet";
        none.textContent = "nothing";
        what.append(none);
    }
    for (const action of entry.actions) {
        const tag = document.createElement("span");
        tag.className = entry.added.includes(action) ? "action new" : "action";
        tag.textContent = action;
        what.append(tag);
    }
    const cost = document.createElement("td");
    cost.className = "cost";
    cost.textContent = Math.round(entry.analyzeMs + entry.decodeMs) + " ms";
    const detail = document.createElement("div");
    detail.className = "breakdown";
    // Where a round actually goes. Prefill is reading the image and the prompt, and dwarfs the rest.
    detail.textContent = "decode " + Math.round(entry.decodeMs)
        + " | in " + Math.round(entry.prefillMs) + " (" + entry.promptTokens + " tok)"
        + " | out " + Math.round(entry.generateMs) + " (" + entry.outputTokens + " tok)";
    cost.append(document.createElement("br"), detail);
    tr.append(when, what, cost);
    return tr;
}

function add(entry, fresh) {
    const tr = row(entry);
    if (fresh) {
        tr.className = "fresh";
    }
    rows.prepend(tr);
    while (rows.children.length > LIMIT) {
        rows.lastElementChild.remove();
    }
}

function setState(state) {
    stats.textContent = state.rounds + " rounds, " + state.failures + " failed";
    buffered.textContent = state.buffered + " frames held, last " + state.bufferSeconds + "s";
    prompt.textContent = state.prompt;
    vocabulary.replaceChildren();
    for (const action of state.vocabulary) {
        const li = document.createElement("li");
        li.textContent = action;
        vocabulary.append(li);
    }
}

function connect() {
    const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host);
    socket.onopen = () => link.classList.remove("down");
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === "init") {
            rows.replaceChildren();
            // Oldest first into a list that prepends, which leaves the newest on top.
            for (const entry of message.entries) {
                add(entry, false);
            }
        } else if (message.type === "entry") {
            add(message.entry, true);
        }
        setState(message.state);
    };
    // Reconnecting rather than reloading keeps whatever is already on screen while the link is down.
    socket.onclose = () => {
        link.classList.add("down");
        setTimeout(connect, 1000);
    };
    socket.onerror = () => socket.close();
}
connect();
</script>`;

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
        const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
        if (url.pathname === "/log") {
            const since = Number(url.searchParams.get("since") ?? 0);
            const limit = Number(url.searchParams.get("limit") ?? BACKLOG_LIMIT);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(recorder.entriesSince(since, limit)));
            return;
        }
        if (url.pathname === "/status") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(recorder.state));
            return;
        }
        if (url.pathname === "/frames") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(recorder.recentFrames()));
            return;
        }
        if (url.pathname.startsWith("/frames/")) {
            const jpeg = recorder.frame(decodeURIComponent(url.pathname.slice("/frames/".length)));
            if (!jpeg) {
                response.writeHead(404).end("that frame has aged out");
                return;
            }
            response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": jpeg.length });
            response.end(jpeg);
            return;
        }
        if (url.pathname === "/annotate" && request.method === "POST") {
            let body = "";
            request.on("data", chunk => {
                body += chunk;
                if (body.length > MAX_NOTE_LENGTH * 8) {
                    request.destroy();
                }
            });
            request.on("end", () => {
                try {
                    const parsed = JSON.parse(body) as { id?: unknown; note?: unknown };
                    const note = String(parsed.note ?? "").trim().slice(0, MAX_NOTE_LENGTH);
                    if (!note) {
                        throw new Error(`A note is required`);
                    }
                    const saved = recorder.annotate(String(parsed.id ?? ""), note);
                    response.writeHead(200, { "Content-Type": "application/json" });
                    response.end(JSON.stringify(saved));
                } catch (error) {
                    response.writeHead(400, { "Content-Type": "application/json" });
                    response.end(JSON.stringify({ error: (error as Error).message }));
                }
            });
            return;
        }
        if (url.pathname === "/") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(PAGE);
            return;
        }
        response.writeHead(404).end("not found");
    });

    // One round is a couple of hundred bytes, so pushing them beats a page that reloads itself and
    // rebuilds a few hundred rows to learn that one was added.
    const sockets = new WebSocketServer({ server });
    sockets.on("connection", (socket: WebSocket) => {
        socket.send(JSON.stringify({ type: "init", entries: recorder.entriesSince(0, BACKLOG_LIMIT), state: recorder.state }));
        const stop = recorder.listen(entry => {
            if (socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ type: "entry", entry, state: recorder.state }));
            }
        });
        socket.on("close", stop);
        socket.on("error", stop);
    });

    server.listen(PORT, HOST, () => {
        log(`serving the action log on http://${HOST}:${PORT}`);
        log(`  /        the page, fed over a websocket`);
        log(`  /log     json, ?since=<ms epoch>&limit=<n>`);
        log(`  /status  rounds and the current vocabulary`);
    });

    // Its own loop, so how often frames are kept does not depend on how long an answer takes.
    void (async () => {
        while (true) {
            const startedAtMs = Date.now();
            await recorder.pullFrame();
            const remainingMs = FRAME_PULL_MS - (Date.now() - startedAtMs);
            if (remainingMs > 0) {
                await new Promise(resolve => setTimeout(resolve, remainingMs));
            }
        }
    })();

    log(`asking camera ${index} ${intervalSeconds > 0 ? `every ${intervalSeconds}s` : `back to back`}, keeping ${vocabularySize} lettered actions`);
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
