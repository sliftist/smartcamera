import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { formatDateTime } from "socket-function/src/formatting/format";
import { dayStamp, millisecondStamp } from "./src/timestamps";
import { buildPrompt, parseAnswers, diffAnswers, parseWatch, canonicalPhrase, DEFAULT_WATCHES, MAX_QUESTIONS, MAX_PHRASE_LENGTH, Watch } from "./src/questions";
import { readPassword, writePassword, passwordMatches, offeredPassword } from "./src/password";
import { isLocalAddress } from "./src/network";
import { readHistory, summarise } from "./src/history";
import { ComparisonRun, nextSizeDown, listRuns, readRun, runDirectory, RUN_LIMIT_MS } from "./src/comparison";

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
/** How long to wait after a round that produced nothing, so a broken model is not asked in a tight loop. */
const FAILURE_BACKOFF_MS = 3_000;
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
/**
 * At most this long between log lines, even when nothing changes.
 *
 * Only writing on change makes a still hour look exactly like an hour when nothing was running, and
 * telling those apart is the whole denominator of "true this much of the time". One line a minute is
 * nothing next to what it buys.
 */
const HEARTBEAT_MS = 60_000;
const TRAINING_DIRECTORY = path.join(__dirname, "training");
/** One folder per comparison run, each with its deviations and the frames that caused them. */
const COMPARISON_DIRECTORY = path.join(LOG_DIRECTORY, "comparisons");
const MAX_NOTE_LENGTH = 500;
/** Optional. With no such file nothing is checked; set one with `yarn password`. */
export const PASSWORD_FILE = path.join(LOG_DIRECTORY, "password.json");

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

type Entry = {
    at: number;
    /** The questions answered yes this round. */
    state: string[];
    /** Questions whose answer flipped since the round before. */
    added: string[];
    removed: string[];
    // Everything below describes the run rather than the room. It is sent live and never written
    // down, so a round recovered from disk has none of it.
    /** Questions the model did not answer at all, which are neither yes nor no. */
    unanswered?: string[];
    /**
     * Words it answered with that were never offered.
     *
     * Shown on the row rather than dropped. A model saying "phone" when nothing asked about phones is
     * telling you what it thinks it is looking at, which is worth seeing and often worth adding.
     */
    unknown?: string[];
    /** Exactly what the model said, so a parsing decision can always be second guessed later. */
    raw?: string;
    promptTokens?: number;
    outputTokens?: number;
    /** Decoding the frame, which is the only part that is not the model. */
    decodeMs?: number;
    /** Reading the image and the prompt, which is where nearly all of a round goes. */
    prefillMs?: number;
    /** Writing the answer, which is why letters are cheaper than phrases. */
    generateMs?: number;
    analyzeMs?: number;
};

type BufferedFrame = {
    id: string;
    at: number;
    jpeg: Buffer;
};

/** Reads a request body whole, for the handful of routes that take one. */
function readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.on("data", chunk => {
            body += chunk;
            if (body.length > 8192) {
                request.destroy();
                reject(new Error("the request body is too large"));
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

/** An entry arrives, or the configuration around it changed and subscribers should refresh. */
type Listener = (entry: Entry | undefined, cleared?: boolean) => void;

class Recorder {
    private watches: Watch[] = [];
    /** What was answered yes last round, so a flip reads as a change. */
    private yes: string[] = [];
    private recent: Entry[] = [];
    private day = "";
    private stream: fs.WriteStream | undefined;
    /** So a quiet stretch still leaves a mark, which is what makes downtime tellable from stillness. */
    private lastWroteAtMs = 0;
    /** Set while a resolution comparison is running, which roughly doubles the cost of a round. */
    private comparison: ComparisonRun | undefined;
    private listeners = new Set<Listener>();
    private frames: BufferedFrame[] = [];
    rounds = 0;
    failures = 0;
    framesMissing = 0;

    constructor(private index: number) {
        fs.mkdirSync(LOG_DIRECTORY, { recursive: true });
        fs.mkdirSync(TRAINING_DIRECTORY, { recursive: true });
        this.loadQuestions();
        this.loadToday();
    }

    private loadQuestions() {
        // Deliberately not read from disk. See DEFAULT_WATCHES: a list that persisted only ever grew,
        // and every entry in it costs tokens on every frame forever.
        this.watches = DEFAULT_WATCHES.map(watch => ({ ...watch }));
        log(`asking the ${this.watches.length} default questions; anything else is added by whoever wants it`);
    }

    private get phrases(): string[] {
        return this.watches.map(watch => watch.phrase);
    }

    listWatches(): Watch[] {
        return this.watches.map(watch => ({ ...watch }));
    }

    listPhrases(): string[] {
        return this.phrases;
    }

    /**
     * Returns the list as it now stands, so a caller sees the result of its own call.
     *
     * The phrase carries the word the model answers with, in parentheses. A phrase without one is
     * refused unless it is a default, which is what lets an older caller keep naming a built in
     * question and know nothing about words at all.
     *
     * This is the only place a phrase is taken apart, and it is the last moment that is any use: a
     * caller adding one is still on the other end of a request and can be told it was refused. The
     * client sends a string and reads a string back, so there is no second copy of this rule to
     * disagree with this one, and no way to be refused by a version of it the service is not running.
     */
    addWatch(phrase: string): Watch[] {
        const watch = parseWatch(phrase);
        if (this.watches.some(candidate => candidate.phrase === watch.phrase)) {
            return this.listWatches();
        }
        if (this.watches.length >= MAX_QUESTIONS) {
            throw new Error(`At most ${MAX_QUESTIONS} phrases can be watched at once`);
        }
        // Two phrases answering to one word makes every answer ambiguous, and the model has no way to
        // tell you which it meant, so this is refused rather than resolved.
        const clash = this.watches.find(candidate => candidate.keyword === watch.keyword);
        if (clash) {
            throw new Error(`The word ${JSON.stringify(watch.keyword)} is already answering for`
                + ` ${JSON.stringify(clash.phrase)}`);
        }
        this.watches.push(watch);
        this.questionsChanged();
        log(`now asking ${JSON.stringify(watch.phrase)}`);
        return this.listWatches();
    }

    /**
     * Removal is a string match and nothing more.
     *
     * Nothing here needs the parts, so nothing here takes the phrase apart. Whatever added a phrase
     * was handed back the exact string it is stored under, which is the string to send to get rid of
     * it, and a name that matches nothing is already the state the caller was asking for.
     */
    removeWatch(phrase: string): Watch[] {
        const wanted = phrase.replace(/\s+/g, " ").trim();
        // A default is permanent. It comes back on the next restart whatever anyone does, so removing
        // one would only mean it disappears until then, which is worse than not being able to.
        if (DEFAULT_WATCHES.some(candidate => candidate.phrase === wanted)) {
            return this.listWatches();
        }
        if (!this.watches.some(candidate => candidate.phrase === wanted)) {
            return this.listWatches();
        }
        this.watches = this.watches.filter(candidate => candidate.phrase !== wanted);
        // Its last answer goes with it, so re-adding it later starts clean rather than resuming.
        this.yes = this.yes.filter(candidate => candidate !== wanted);
        this.questionsChanged();
        log(`no longer asking ${JSON.stringify(wanted)}`);
        return this.listWatches();
    }

    comparisonState(): Record<string, unknown> {
        if (this.comparison?.expired) {
            this.stopComparison();
        }
        return this.comparison
            ? {
                running: true,
                run: this.comparison.run,
                startedAt: this.comparison.startedAt,
                endsAt: this.comparison.endsAt,
                rounds: this.comparison.rounds,
                deviations: this.comparison.deviations,
                higher: this.comparison.higher,
                lower: this.comparison.lower,
            }
            : { running: false };
    }

    async startComparison(): Promise<Record<string, unknown>> {
        if (this.comparison) {
            return this.comparisonState();
        }
        const response = await fetch(`${EYE2_URL}/resolution`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        const higher = await response.json() as { width: number; height: number };
        const lower = nextSizeDown(higher);
        if (!lower) {
            throw new Error(`Already at the smallest size, so there is nothing below it to compare against`);
        }
        this.comparison = new ComparisonRun(COMPARISON_DIRECTORY, { width: higher.width, height: higher.height }, lower);
        log(`comparing ${higher.width}x${higher.height} against ${lower.width}x${lower.height}`
            + ` for up to ${RUN_LIMIT_MS / 60000} minutes, as run ${this.comparison.run}`);
        this.questionsChanged();
        return this.comparisonState();
    }

    stopComparison(): Record<string, unknown> {
        if (this.comparison) {
            log(`stopped comparing after ${this.comparison.rounds} rounds`
                + ` with ${this.comparison.deviations} disagreements`);
            this.comparison.close();
            this.comparison = undefined;
            this.questionsChanged();
        }
        return { running: false };
    }

    /** Nothing is written; this only tells everyone the list moved so they can put theirs back. */
    private questionsChanged() {
        for (const listener of this.listeners) {
            listener(undefined);
        }
    }

    /**
     * Throws away every day file and starts again from what is true right now.
     *
     * A fresh file is written immediately rather than waiting for the next round, and it holds the
     * current state rather than nothing. Both matter: the files hold changes, so one that began empty
     * would replay against an empty scene and get everything already true at the moment of clearing
     * wrong for as long as it stayed true.
     */
    clearHistory(): { removed: number } {
        this.stream?.end();
        this.stream = undefined;
        let removed = 0;
        for (const name of fs.readdirSync(LOG_DIRECTORY)) {
            if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) {
                fs.rmSync(path.join(LOG_DIRECTORY, name), { force: true });
                removed++;
            }
        }
        this.recent = [];
        this.day = "";
        this.lastWroteAtMs = 0;

        const at = Date.now();
        const today = dayStamp(at);
        this.stream = fs.createWriteStream(path.join(LOG_DIRECTORY, `${today}.jsonl`), { flags: "a" });
        this.stream.write(JSON.stringify({ at, state: this.yes }) + "\n");
        this.day = today;
        this.lastWroteAtMs = at;

        log(`cleared ${removed} day file${removed === 1 ? "" : "s"}, starting again from ${this.yes.length} true`);
        for (const listener of this.listeners) {
            listener(undefined, true);
        }
        return { removed };
    }

    /** Restarting mid day must not start the page from nothing, or re-describe a scene it knows. */
    private loadToday() {
        const file = path.join(LOG_DIRECTORY, `${dayStamp(Date.now())}.jsonl`);
        if (!fs.existsSync(file)) {
            return;
        }
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(line => line.trim());
        // Replayed rather than read, since only changes were written. The first line is the state the
        // day opened in and everything after it is a change to that.
        let state: string[] = [];
        for (const line of lines) {
            try {
                const logged = JSON.parse(line) as { at: number; state?: string[]; added?: string[]; removed?: string[] };
                // Lines written before the word moved into the phrase say "is a person present" where
                // today's say "is a person present (person)". Read as the same thing, or replaying the
                // morning would leave every one of them stuck on as something nothing can turn off.
                const added = (logged.added ?? []).map(canonicalPhrase);
                const removed = (logged.removed ?? []).map(canonicalPhrase);
                logged.state = logged.state?.map(canonicalPhrase);
                state = logged.state
                    ? [...logged.state]
                    : [...state.filter(item => !removed.includes(item)), ...added.filter(item => !state.includes(item))];
                // Timings are not on disk, so a recovered round has none and the page leaves that
                // column out for it rather than showing a confident zero.
                this.recent.push({ at: logged.at, state: [...state], added, removed });
            } catch {
                // A half written last line is expected after a hard stop, and is not worth a complaint.
            }
        }
        this.recent = this.recent.slice(-RECENT_LIMIT);
        // Only answers to phrases still being asked carry over; the rest were about phrases that
        // have since been removed or reworded.
        this.yes = state.filter(phrase => this.phrases.includes(phrase));
        log(`recovered ${lines.length} lines from today, ${this.yes.length} currently true`);
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

    /**
     * Frames are pulled faster than questions are asked, so a frame rarely has a round of its own.
     * The nearest round in time is what the model was saying about that moment, which is the thing a
     * reviewer needs in front of them: you cannot say what was missed without seeing what was caught.
     */
    private nearestEntry(at: number): Entry | undefined {
        return this.recent.reduce<Entry | undefined>((closest, candidate) => {
            if (!closest) {
                return candidate;
            }
            return Math.abs(candidate.at - at) < Math.abs(closest.at - at) ? candidate : closest;
        }, undefined);
    }

    recentFrames(): { id: string; at: number; reported: string[]; raw: string }[] {
        const cutoff = Date.now() - FRAME_BUFFER_MS;
        return this.frames.filter(frame => frame.at >= cutoff).map(frame => {
            const entry = this.nearestEntry(frame.at);
            return { id: frame.id, at: frame.at, reported: entry?.state ?? [], raw: entry?.raw ?? "" };
        });
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
        const entry = this.nearestEntry(frame.at);
        const stem = millisecondStamp(frame.at);
        fs.writeFileSync(path.join(TRAINING_DIRECTORY, `${stem}.jpg`), frame.jpeg);
        fs.writeFileSync(path.join(TRAINING_DIRECTORY, `${stem}.json`), JSON.stringify({
            at: frame.at,
            missing: note,
            reported: entry?.state ?? [],
            raw: entry?.raw ?? "",
            prompt: buildPrompt(this.watches),
        }, undefined, 2));
        log(`annotated ${stem}: ${JSON.stringify(note)}`);
        return { saved: `${stem}.jpg` };
    }

    listen(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * A day per file, and only what cannot be worked out again.
     *
     * A round is almost always identical to the one before it, so writing the whole state every time
     * wrote the same list a thousand times an hour. Only changes go down, and a round where nothing
     * flipped writes nothing at all, which is most of them.
     *
     * Each file opens with the full state so it stands alone. Without that, replaying a day that
     * began mid-afternoon would apply its changes to an empty scene and get the wrong answer for
     * everything that was already true at midnight.
     *
     * Timings and token counts are not written. They describe the run rather than the room, they are
     * the bulk of a line, and nothing reads them back.
     */
    private append(entry: Entry) {
        const today = dayStamp(entry.at);
        if (today !== this.day) {
            this.stream?.end();
            this.stream = fs.createWriteStream(path.join(LOG_DIRECTORY, `${today}.jsonl`), { flags: "a" });
            this.day = today;
            this.stream.write(JSON.stringify({ at: entry.at, state: entry.state }) + "\n");
            this.lastWroteAtMs = entry.at;
        } else if (entry.at - this.lastWroteAtMs >= HEARTBEAT_MS) {
            // Writing only on change makes a quiet hour indistinguishable from an hour when nothing
            // was running, and the difference is the whole denominator for "how much of the time".
            // A line at least this often bounds a gap, so anything longer than one is downtime.
            this.stream?.write(JSON.stringify({ at: entry.at, state: entry.state }) + "\n");
            this.lastWroteAtMs = entry.at;
        } else if (entry.added.length > 0 || entry.removed.length > 0) {
            const line: { at: number; added?: string[]; removed?: string[] } = { at: entry.at };
            if (entry.added.length > 0) {
                line.added = entry.added;
            }
            if (entry.removed.length > 0) {
                line.removed = entry.removed;
            }
            this.stream?.write(JSON.stringify(line) + "\n");
            this.lastWroteAtMs = entry.at;
        }
        this.recent.push(entry);
        if (this.recent.length > RECENT_LIMIT) {
            this.recent.shift();
        }
        for (const listener of this.listeners) {
            listener(entry);
        }
    }

    /** False when the round produced nothing, which is the caller's cue to back off rather than spin. */
    async round(): Promise<boolean> {
        if (this.phrases.length === 0) {
            return false;
        }
        const prompt = buildPrompt(this.watches);
        const at = Date.now();
        // Stops itself, so an afternoon of double cost cannot be left running by forgetting about it.
        if (this.comparison?.expired) {
            this.stopComparison();
        }
        const compare = this.comparison?.lower;
        let reply: Record<string, unknown>;
        try {
            const response = await fetch(EYE2_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ index: String(this.index), prompt, compare }),
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            reply = await response.json() as Record<string, unknown>;
        } catch (error) {
            this.failures++;
            log(`asking failed: ${(error as Error).message}`);
            return false;
        }
        if (typeof reply.error === "string") {
            this.failures++;
            log(`eye2 refused: ${reply.error}`);
            return false;
        }

        const raw = String(reply.answer ?? "");
        const { yes, answered, unknown } = parseAnswers(raw, this.watches);
        // Compared only against the phrases this round actually answered. One the model skipped is
        // not a no, and treating it as one would report something leaving that nobody said had left.
        const before = this.yes.filter(phrase => answered.includes(phrase));
        const { added, removed } = diffAnswers(before, yes);
        const unanswered = this.phrases.filter(phrase => !answered.includes(phrase));
        const entry: Entry = {
            at,
            // A skipped phrase keeps its last answer rather than flapping to no and back.
            state: this.phrases.filter(phrase =>
                yes.includes(phrase) || (unanswered.includes(phrase) && this.yes.includes(phrase))),
            added,
            removed,
            unanswered,
            unknown,
            raw,
            promptTokens: Number(reply.promptTokens ?? 0),
            outputTokens: Number(reply.outputTokens ?? 0),
            decodeMs: Number(reply.decodeMs ?? 0),
            prefillMs: Number(reply.prefillMs ?? 0),
            generateMs: Number(reply.generateMs ?? 0),
            analyzeMs: Number(reply.analyzeMs ?? 0),
        };
        // The comparison reads the same reply rather than asking again, so both sizes answered about
        // one frame and any difference is the size rather than the moment.
        if (this.comparison && reply.comparison) {
            const other = reply.comparison as Record<string, unknown>;
            const lower = parseAnswers(String(other.answer ?? ""), this.watches).yes;
            this.comparison.record(at, yes, lower, typeof reply.frameJpeg === "string" ? reply.frameJpeg : undefined);
        }
        this.yes = entry.state;
        this.append(entry);
        this.rounds++;

        // Only the flips are logged. A round where nothing changed is one line saying so.
        const change = [...added.map(item => `+ ${item}`), ...removed.map(item => `- ${item}`)];
        log(`${entry.outputTokens} out tok, ${(entry.analyzeMs ?? 0).toFixed(0)}ms`
            + ` | ${change.join(" | ") || "no change"}`
            + ` | ${entry.state.length}/${this.watches.length} yes`
            + `${unanswered.length > 0 ? `, ${unanswered.length} unanswered` : ""}`
            + `${unknown.length > 0 ? `  ?? ${unknown.join(", ")}` : ""}`);
        return true;
    }

    get state() {
        return {
            rounds: this.rounds,
            failures: this.failures,
            buffered: this.recentFrames().length,
            bufferSeconds: FRAME_BUFFER_MS / 1000,
            /** Split into question and word, for anything that wants the parts rather than the whole. */
            watches: this.listWatches(),
            /** The phrases being watched, word and all. What an entry reports is one of these. */
            phrases: this.listPhrases(),
            /** So the page can show which are permanent, and offer no way to remove those. */
            defaults: DEFAULT_WATCHES.map(watch => watch.phrase),
            yes: [...this.yes],
            // Sent so the wording can be reviewed against the answers it is producing, live.
            prompt: buildPrompt(this.watches),
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
/* A grid that fills the window rather than a row that scrolls sideways. The minimum column is wide
   enough that a person across the room is actually visible, which is the point of looking at these. */
#strip { display: grid; grid-template-columns: repeat(auto-fill, minmax(440px, 1fr)); gap: 14px; padding: 12px 0; }
#strip figure { margin: 0; cursor: pointer; }
#strip img { display: block; width: 100%; aspect-ratio: 1252 / 704; object-fit: cover; border-radius: 6px; border: 2px solid transparent; background: #8881; }
#strip figure:hover img { border-color: #d9822b; }
#strip figcaption { font-size: 12px; opacity: .65; margin-top: 5px; }
#strip figure.picked img { border-color: #d9822b; }
/* Inline under the grid, never over it: the point is to compare the note against the picture. */
#editor { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 18px; align-items: start;
          border: 1px solid var(--line); border-radius: 8px; padding: 14px; margin-bottom: 16px; }
#editor img { width: 100%; border-radius: 6px; }
#editor h2 { margin-top: 0; }
#editor h2 + div { margin-bottom: 14px; }
#editor textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border-radius: 6px;
                   border: 1px solid var(--line); background: none; color: inherit; resize: vertical; }
#editor .buttons { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
@media (max-width: 700px) { #editor { grid-template-columns: 1fr; } }
@media (max-width: 520px) { #strip { grid-template-columns: 1fr; } }
.saved { color: #2ba84a; }
.breakdown { font-size: 11px; opacity: .55; white-space: nowrap; }
table { border-collapse: collapse; width: 100%; }
td { border-top: 1px solid var(--line); padding: 7px 6px; vertical-align: top; }
.time { white-space: nowrap; opacity: .7; width: 1%; }
.cost { white-space: nowrap; opacity: .55; text-align: right; width: 1%; }
/* Carrying the scene on every row only reads if the unchanged part recedes, so it does. */
.action { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 10px;
          margin: 2px 4px 2px 0; opacity: .5; }
.action.new { border-color: #d9822b; color: #d9822b; font-weight: 600; opacity: 1; }
.action.gone { border-color: #c25b5b; color: #c25b5b; text-decoration: line-through; opacity: .9; }
/* A word it answered with that was never offered. Worth seeing, not worth alarming about. */
.action.strange { border-style: dashed; border-color: #b08a2e; color: #b08a2e; opacity: 1; }
/* In the annotation panel there is no diff to read, so the scene is shown at full strength. */
#editor .action { opacity: 1; }
.pins { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
.pin { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line); border-radius: 999px;
       padding: 2px 4px 2px 11px; margin-right: 6px; margin-bottom: 4px; }
/* Permanent ones read as part of the furniture: filled, no cross, nothing to click. */
.pin.always { padding: 2px 11px; background: #8882; border-color: transparent; }
.pin button { border: none; background: none; color: inherit; cursor: pointer; opacity: .5; padding: 0 6px;
              font-size: 15px; line-height: 1; border-radius: 999px; }
.pin button:hover { opacity: 1; }
#pin, #secret { display: inline-flex; gap: 6px; margin-bottom: 6px; }
#res { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 6px; }
#res button { opacity: .75; }
#res button.picked { opacity: 1; border-color: #d9822b; color: #d9822b; font-weight: 600; }
#resNote { margin-bottom: 16px; min-height: 1.2em; }
#secret input { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px;
                background: none; color: inherit; min-width: 200px; }
#secretNote { margin-bottom: 16px; min-height: 1.2em; }
#pin input { font: inherit; padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px;
             background: none; color: inherit; min-width: 340px; }
#pinNote { margin-bottom: 16px; min-height: 1.2em; }
.viewbar { margin: 4px 0 8px; }
#deviations { margin-bottom: 16px; }
#deviations table { width: auto; min-width: min(560px, 100%); margin-bottom: 10px; }
#deviations td { padding: 4px 14px 4px 0; }
#deviations img { display: block; width: 100%; max-width: 440px; border-radius: 6px; margin-top: 6px; }
#deviations figure { margin: 0 0 14px; }
#deviations figcaption { font-size: 12px; opacity: .7; margin-bottom: 4px; }
#historyTable { width: auto; min-width: min(560px, 100%); margin-bottom: 6px; }
#historyTable td { padding: 5px 14px 5px 0; }
#historyTable td.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
#historyTable .bar { display: inline-block; height: 7px; border-radius: 4px; background: #d9822b; vertical-align: middle; }
#statsNote { margin-bottom: 16px; }
.viewbar button { opacity: .8; }
.badge { display: inline-block; border-radius: 4px; padding: 1px 7px; margin-right: 6px; font-size: 11px;
         text-transform: uppercase; letter-spacing: .05em; background: #8882; opacity: .8; }
.quiet { opacity: .5; }
/* New rounds arrive at the top, so they fade in rather than making the whole list jump. */
tr.fresh { animation: in .35s ease-out; }
@keyframes in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
</style>
<h1>eye actions</h1>
<div class="meta"><span id="link"></span><span id="stats">connecting</span></div>
<details><summary>the prompt being sent right now</summary><pre id="prompt"></pre></details>
<h2>password</h2>
<!-- Not masked. You are choosing a shared password for a camera on your own network, not entering one
     in a cafe, and hiding it only buys a typo you cannot see. -->
<form id="secret"><input id="secretValue" type="text" placeholder="leave empty to remove" autocomplete="off" spellcheck="false"><button type="submit">set</button></form>
<div id="secretNote" class="quiet"></div>
<h2>history <span id="statsSpan" class="quiet"></span></h2>
<div class="viewbar"><button id="clearHistory" type="button">clear history</button></div>
<table id="historyTable"></table>
<div id="statsNote" class="quiet"></div>
<h2>resolution shown to the model</h2>
<div id="res"></div>
<div class="viewbar"><button id="compare" type="button">compare with the next size down</button><button id="showDeviations" type="button">deviations</button></div>
<div id="resNote" class="quiet"></div>
<div id="deviations"></div>
<h2>watched in every frame</h2>
<div class="pins"><span id="interests"></span></div>
<form id="pin"><input id="phrase" placeholder="e.g. is anyone holding a phone (phone)" maxlength="140" autocomplete="off"><button type="submit">add</button></form>
<div id="pinNote" class="quiet"></div>
<h2>true right now</h2>
<ul id="vocabulary"></ul>
<h2>frames <span id="buffered" class="quiet"></span></h2>
<div><button id="capture">capture frames</button> <span id="note" class="quiet"></span></div>
<div id="strip"></div>
<div id="editor" hidden></div>
<div class="viewbar"><button id="view" type="button"></button></div>
<table><tbody id="rows"></tbody></table>
<script>
/**
 * Remembered so it is typed once per browser rather than once per reload. localStorage is per origin
 * and never leaves the machine, which for a password on a home network is the right trade.
 */
let password = "";
try { password = localStorage.getItem("eye-password") || ""; } catch (error) { password = ""; }

/** One place the password is attached, and one place a refusal is handled. */
async function api(path, options) {
    const settings = Object.assign({}, options || {});
    settings.headers = Object.assign({}, settings.headers);
    if (password) {
        settings.headers.Authorization = "Bearer " + password;
    }
    const response = await fetch(path, settings);
    if (response.status === 401) {
        askForPassword("that password was not accepted");
        throw new Error("unauthorised");
    }
    return response;
}

// An img tag cannot carry a header, so a frame is fetched with the password in the query instead.
function framePath(id) {
    const base = "/frames/" + encodeURIComponent(id);
    return password ? base + "?password=" + encodeURIComponent(password) : base;
}

let asking = false;
function askForPassword(why) {
    // Several things load at once and would each get their own refusal, so only the first one asks.
    if (asking) {
        return;
    }
    asking = true;
    const given = window.prompt(why ? why + ". password:" : "password:");
    if (given === null) {
        // Cancelled. Let the next refusal ask again, or nothing would ever prompt after a change of mind.
        asking = false;
        return;
    }
    password = given;
    try { localStorage.setItem("eye-password", password); } catch (error) { /* private window: lasts this session */ }
    location.reload();
}

// Reaching the page at all means the current password was accepted, or that there is none, so
// setting one from here needs no further proof. Empty removes it.
document.getElementById("secret").onsubmit = async event => {
    event.preventDefault();
    const field = document.getElementById("secretValue");
    const wanted = field.value;
    const note = document.getElementById("secretNote");
    const response = await api("/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: wanted }),
    });
    const reply = await response.json();
    if (reply.error) {
        note.textContent = reply.error;
        return;
    }
    // Remembered immediately, or the next request from this page would be refused by the new one.
    password = wanted;
    try { localStorage.setItem("eye-password", password); } catch (error) { /* private window */ }
    field.value = "";
    note.textContent = reply.set ? "password set, and remembered in this browser" : "password removed";
    note.className = "saved";
};

// A frame is downscaled to fit inside this before the model sees it, and the aspect ratio is kept,
// so 1280x704 against a 1920x1080 camera actually sends 1252x704. Cost goes with area: measured on
// this camera, 1280x704 is about 1s a frame and 1920x1080 about 3.2s.
// A button per size rather than a box to type in. Nothing between these sizes is a distinction worth
// making, and the times in brackets are what the choice is actually about.
async function showResolution(budget) {
    const note = document.getElementById("resNote");
    const holder = document.getElementById("res");
    if (!budget) {
        try {
            budget = await (await api("/resolution")).json();
        } catch (error) {
            note.textContent = "could not reach eye2 to ask";
            return;
        }
    }
    if (budget.error) {
        note.textContent = budget.error;
        return;
    }
    holder.replaceChildren();
    for (const preset of budget.presets || []) {
        const button = document.createElement("button");
        button.type = "button";
        const seconds = preset.frameMs >= 1000
            ? (preset.frameMs / 1000).toFixed(1) + "s"
            : preset.frameMs + "ms";
        button.textContent = preset.width + "x" + preset.height + " (" + seconds + ")";
        if (preset.width === budget.width && preset.height === budget.height) {
            button.className = "picked";
        }
        button.onclick = async () => {
            const reply = await (await api("/resolution", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ width: preset.width, height: preset.height }),
            })).json();
            await showResolution(reply);
        };
        holder.append(button);
    }
    note.textContent = "frames are fitted inside " + budget.width + "x" + budget.height
        + ", keeping the aspect ratio, so the camera's 1920x1080 goes in a little narrower than that."
        + " times are what a frame took when measured.";
    note.className = "quiet";
}

function duration(ms) {
    const hours = ms / 3600000;
    if (hours >= 1) {
        return hours.toFixed(1) + "h";
    }
    const minutes = ms / 60000;
    return minutes >= 1 ? minutes.toFixed(0) + "m" : Math.round(ms / 1000) + "s";
}

/**
 * Read once on load. The files are small, being changes and a heartbeat, so this is a fetch and a
 * walk rather than anything that needs its own storage.
 */
async function showHistory() {
    const table = document.getElementById("historyTable");
    const note = document.getElementById("statsNote");
    const span = document.getElementById("statsSpan");
    let summary;
    try {
        summary = await (await api("/stats?days=7")).json();
    } catch (error) {
        return;
    }
    span.textContent = summary.days.length + " day" + (summary.days.length === 1 ? "" : "s")
        + ", " + duration(summary.trackedMs) + " actually watched";
    table.replaceChildren();
    for (const item of summary.conditions) {
        const tr = document.createElement("tr");
        const what = document.createElement("td");
        what.textContent = item.condition;
        const share = document.createElement("td");
        share.className = "num";
        share.textContent = (item.fraction * 100).toFixed(1) + "%";
        const bar = document.createElement("td");
        const fill = document.createElement("span");
        fill.className = "bar";
        fill.style.width = Math.max(1, Math.round(item.fraction * 120)) + "px";
        bar.append(fill);
        const time = document.createElement("td");
        time.className = "num";
        time.textContent = duration(item.trueMs);
        const times = document.createElement("td");
        times.className = "num";
        // Occurrences, not rounds: an hour at the desk is one of these, not two thousand.
        times.textContent = item.instances + (item.instances === 1 ? " time" : " times");
        tr.append(what, share, bar, time, times);
        table.append(tr);
    }
    note.textContent = summary.conditions.length === 0
        ? "no history yet"
        : "share of the time it was being watched, not of the wall clock: a stretch where nothing was"
            + " running is left out rather than credited to whatever was true when it stopped.";
}

// Deliberately not loaded with the page. A run's frames are the one heavy thing here, and nobody
// wants them fetched on every reload for a comparison they ran last week.
const compareButton = document.getElementById("compare");
const deviationsHolder = document.getElementById("deviations");

async function showComparison(state) {
    if (!state) {
        try {
            state = await (await api("/comparison")).json();
        } catch (error) {
            return;
        }
    }
    if (state.running) {
        const left = Math.max(0, Math.round((state.endsAt - Date.now()) / 60000));
        compareButton.textContent = "stop comparing (" + state.lower.width + "x" + state.lower.height
            + ", " + state.deviations + "/" + state.rounds + " differ, " + left + "m left)";
        compareButton.className = "picked";
    } else {
        compareButton.textContent = "compare with the next size down";
        compareButton.className = "";
    }
}

compareButton.onclick = async () => {
    const now = await (await api("/comparison")).json();
    const reply = await (await api("/comparison", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !now.running }),
    })).json();
    if (reply.error) {
        document.getElementById("resNote").textContent = reply.error;
        return;
    }
    await showComparison(reply);
};

document.getElementById("showDeviations").onclick = async () => {
    if (deviationsHolder.children.length > 0) {
        deviationsHolder.replaceChildren();
        return;
    }
    const runs = (await (await api("/comparisons")).json()).runs || [];
    if (runs.length === 0) {
        deviationsHolder.textContent = "no comparison runs yet";
        return;
    }
    const { summary, deviations } = await (await api("/comparisons/" + encodeURIComponent(runs[0]))).json();
    deviationsHolder.replaceChildren();

    const heading = document.createElement("div");
    heading.className = "quiet";
    heading.textContent = summary.higher.width + "x" + summary.higher.height + " against "
        + summary.lower.width + "x" + summary.lower.height + ", " + summary.deviations
        + " of " + summary.rounds + " rounds disagreed. run " + summary.run;
    deviationsHolder.append(heading);

    // Which way it went matters more than how often. A question the smaller size keeps missing is a
    // reason not to use it; one it keeps inventing is a different problem entirely.
    const table = document.createElement("table");
    for (const row of summary.byQuestion) {
        const tr = document.createElement("tr");
        const what = document.createElement("td");
        what.textContent = row.question;
        const missed = document.createElement("td");
        missed.textContent = row.missedByLower + " missed by the smaller";
        const extra = document.createElement("td");
        extra.textContent = row.extraInLower + " only the smaller saw";
        tr.append(what, missed, extra);
        table.append(tr);
    }
    deviationsHolder.append(table);

    for (const deviation of deviations.slice(-25).reverse()) {
        const figure = document.createElement("figure");
        const caption = document.createElement("figcaption");
        caption.textContent = time(deviation.at) + " differed on: " + deviation.differ.join(", ");
        figure.append(caption);
        for (const question of deviation.differ) {
            const chip = document.createElement("span");
            const inHigher = deviation.higher.includes(question);
            chip.className = inHigher ? "action new" : "action gone";
            chip.textContent = question + (inHigher ? " (only the larger)" : " (only the smaller)");
            figure.append(chip);
        }
        if (deviation.frame) {
            const image = document.createElement("img");
            image.src = "/comparisons/" + encodeURIComponent(summary.run) + "/frames/"
                + encodeURIComponent(deviation.frame) + (password ? "?password=" + encodeURIComponent(password) : "");
            image.loading = "lazy";
            figure.append(image);
        }
        deviationsHolder.append(figure);
    }
};

document.getElementById("clearHistory").onclick = async () => {
    if (!window.confirm("Delete every day file and start the history again from what is true now?")) {
        return;
    }
    const reply = await (await api("/history", { method: "DELETE" })).json();
    document.getElementById("statsNote").textContent = "cleared " + reply.removed
        + " day file" + (reply.removed === 1 ? "" : "s");
    await showHistory();
};

async function showPasswordState() {
    try {
        const reply = await (await api("/password")).json();
        document.getElementById("secretNote").textContent = reply.set
            ? "a password is set; everything needs it, including the websocket"
            : "no password set, so anything on this network can read and change all of this";
    } catch (error) {
        // Unauthorised, which askForPassword has already handled.
    }
}

const rows = document.getElementById("rows");
const viewToggle = document.getElementById("view");
/** Which of the two views the log is in. Remembered per browser. */
let everything = false;
try { everything = localStorage.getItem("eye-view") === "everything"; } catch (error) { everything = false; }
viewToggle.onclick = () => setView(!everything);
const vocabulary = document.getElementById("vocabulary");
const stats = document.getElementById("stats");
const prompt = document.getElementById("prompt");
const buffered = document.getElementById("buffered");
const strip = document.getElementById("strip");
const note = document.getElementById("note");

const interests = document.getElementById("interests");
const pinNote = document.getElementById("pinNote");
const phrase = document.getElementById("phrase");

// Pinning changes the wording the model is told to use, so the next round re-describes the scene and
// the new state arrives over the socket. Nothing here has to re-render on its own.
document.getElementById("pin").onsubmit = async event => {
    event.preventDefault();
    const wanted = phrase.value.trim();
    if (!wanted) {
        return;
    }
    const response = await api("/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phrase: wanted }),
    });
    const reply = await response.json();
    if (reply.error) {
        pinNote.textContent = reply.error;
        return;
    }
    phrase.value = "";
    pinNote.textContent = "added. it is asked of the next frame, about a second from now.";
};

const capture = document.getElementById("capture");
const editor = document.getElementById("editor");
let selected = null;

function closeEditor() {
    selected = null;
    editor.hidden = true;
    editor.replaceChildren();
    for (const figure of strip.children) {
        figure.classList.remove("picked");
    }
}

/**
 * An inline panel under the grid rather than a browser prompt. The whole point of annotating is to
 * compare what the model said against what is in the frame, and a prompt box shows neither: it covers
 * the page, gives you one line, and cannot show the picture you are being asked about.
 */
function openEditor(frame, figure) {
    selected = frame.id;
    for (const other of strip.children) {
        other.classList.toggle("picked", other === figure);
    }
    editor.replaceChildren();
    editor.hidden = false;

    const image = document.createElement("img");
    image.src = framePath(frame.id);
    const side = document.createElement("div");

    const when = document.createElement("h2");
    when.textContent = "the model reported, at " + time(frame.at);
    const chips = document.createElement("div");
    if (frame.reported.length === 0) {
        const none = document.createElement("span");
        none.className = "quiet";
        none.textContent = "nothing yet";
        chips.append(none);
    }
    for (const action of frame.reported) {
        const chip = document.createElement("span");
        chip.className = "action";
        chip.textContent = action;
        chips.append(chip);
    }

    const ask = document.createElement("h2");
    ask.textContent = "what did it miss?";
    const field = document.createElement("textarea");
    field.rows = 3;
    field.placeholder = "e.g. the person is holding a phone";
    const save = document.createElement("button");
    save.textContent = "save for training";
    const cancel = document.createElement("button");
    cancel.textContent = "cancel";
    const status = document.createElement("span");
    status.className = "quiet";
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    buttons.append(save, cancel, status);

    save.onclick = async () => {
        const missing = field.value.trim();
        if (!missing) {
            status.textContent = "say what was missed first";
            status.className = "quiet";
            field.focus();
            return;
        }
        save.disabled = true;
        status.textContent = "saving";
        status.className = "quiet";
        const response = await api("/annotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: frame.id, note: missing }),
        });
        const reply = await response.json();
        save.disabled = false;
        if (reply.error) {
            status.textContent = "could not save: " + reply.error;
            status.className = "quiet";
            return;
        }
        note.textContent = "saved " + reply.saved;
        note.className = "saved";
        closeEditor();
    };
    cancel.onclick = closeEditor;
    // Enter saves, shift+enter for a second line, escape backs out.
    field.onkeydown = event => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            save.click();
        } else if (event.key === "Escape") {
            closeEditor();
        }
    };

    side.append(when, chips, ask, field, buttons);
    editor.append(image, side);
    field.focus();
}

capture.onclick = async () => {
    // Toggles, so the grid can be put away again once you are done with it.
    if (strip.children.length > 0) {
        strip.replaceChildren();
        closeEditor();
        note.textContent = "";
        capture.textContent = "capture frames";
        return;
    }
    const frames = await (await api("/frames")).json();
    strip.replaceChildren();
    note.textContent = frames.length ? "click a frame to say what it missed" : "no frames held yet";
    note.className = "quiet";
    capture.textContent = "hide frames";
    // Newest first, matching the log above it.
    for (const frame of frames.slice().reverse()) {
        const figure = document.createElement("figure");
        const image = document.createElement("img");
        image.src = framePath(frame.id);
        image.loading = "lazy";
        const caption = document.createElement("figcaption");
        caption.textContent = time(frame.at) + " · " + frame.reported.length + " reported";
        figure.append(image, caption);
        figure.onclick = () => {
            if (selected === frame.id) {
                closeEditor();
            } else {
                openEditor(frame, figure);
            }
        };
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

    function chip(text, kind) {
        const tag = document.createElement("span");
        tag.className = kind ? "action " + kind : "action";
        tag.textContent = text;
        what.append(tag);
    }

    // Everything true, with what changed standing out in it, or only what changed. Both are worth
    // reading and neither is worth reading all the time: the full state answers "what is going on"
    // and the deltas answer "when did it start", and a column of one is no use for the other.
    if (everything) {
        for (const answer of entry.state) {
            chip(answer, entry.added.includes(answer) ? "new" : "");
        }
        // Shown after, because they are no longer true but are the other half of the change.
        for (const answer of entry.removed) {
            chip(answer, "gone");
        }
        if (entry.state.length === 0 && entry.removed.length === 0) {
            const none = document.createElement("span");
            none.className = "quiet";
            none.textContent = "nothing";
            what.append(none);
        }
    } else {
        for (const answer of entry.added) {
            chip(answer, "new");
        }
        for (const answer of entry.removed) {
            chip(answer, "gone");
        }
        if (entry.added.length === 0 && entry.removed.length === 0) {
            const none = document.createElement("span");
            none.className = "quiet";
            none.textContent = "no change";
            what.append(none);
        }
    }
    // Words it used that were never offered. Kept in front of you rather than dropped: it is saying
    // what it thinks it sees, and often it is worth adding.
    for (const word of entry.unknown || []) {
        chip(word, "strange");
    }
    const cost = document.createElement("td");
    cost.className = "cost";
    // Timings are never written down, so a round recovered from a log file has none. Left blank
    // rather than shown as a confident zero.
    if (typeof entry.analyzeMs === "number") {
        cost.textContent = Math.round(entry.analyzeMs + (entry.decodeMs || 0)) + " ms";
        const detail = document.createElement("div");
        detail.className = "breakdown";
        // Where a round actually goes. Prefill is reading the image and the prompt, and dwarfs the rest.
        detail.textContent = "decode " + Math.round(entry.decodeMs || 0)
            + " | in " + Math.round(entry.prefillMs || 0) + " (" + entry.promptTokens + " tok)"
            + " | out " + Math.round(entry.generateMs || 0) + " (" + entry.outputTokens + " tok)";
        cost.append(document.createElement("br"), detail);
    }
    tr.append(when, what, cost);
    return tr;
}

// Kept so switching between the two views can redraw what is already on screen, rather than showing
// the old view until enough new rounds have arrived to replace it.
const shown = [];

function add(entry, fresh) {
    shown.push(entry);
    while (shown.length > LIMIT) {
        shown.shift();
    }
    const tr = row(entry);
    if (fresh) {
        tr.className = "fresh";
    }
    rows.prepend(tr);
    while (rows.children.length > LIMIT) {
        rows.lastElementChild.remove();
    }
}

function redraw() {
    rows.replaceChildren();
    // Oldest first into a list that prepends, which leaves the newest on top.
    for (const entry of shown) {
        rows.prepend(row(entry));
    }
}

function setView(wantEverything) {
    everything = wantEverything;
    try { localStorage.setItem("eye-view", everything ? "everything" : "changes"); } catch (error) { /* private window */ }
    viewToggle.textContent = everything ? "showing everything" : "showing changes only";
    viewToggle.title = everything ? "switch to changes only" : "switch to everything true";
    redraw();
}

function setState(state) {
    stats.textContent = state.rounds + " rounds, " + state.failures + " failed";
    buffered.textContent = state.buffered + " frames held, last " + state.bufferSeconds + "s";
    prompt.textContent = state.prompt;
    vocabulary.replaceChildren();
    for (const action of state.yes) {
        const li = document.createElement("li");
        li.textContent = action;
        vocabulary.append(li);
    }
    interests.replaceChildren();
    const phrases = state.phrases || [];
    if (phrases.length === 0) {
        const none = document.createElement("span");
        none.className = "quiet";
        none.textContent = "nothing watched yet, so nothing is being asked";
        interests.append(none);
    }
    // Permanent ones first and marked as such, with no cross on them. A default survives a restart
    // whatever anyone does, so offering to remove one would only mean it vanishes until then.
    const defaults = state.defaults || [];
    const sorted = phrases.slice().sort((left, right) =>
        Number(defaults.includes(right)) - Number(defaults.includes(left)));
    for (const item of sorted) {
        const pin = document.createElement("span");
        const permanent = defaults.includes(item);
        pin.className = permanent ? "pin always" : "pin";
        // The whole phrase, word in parentheses and all. That word is what the model actually answers
        // and therefore what you change when an answer comes back wrong, so it belongs on screen.
        pin.append(item);
        if (permanent) {
            pin.title = "always asked, and cannot be removed";
        } else {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.textContent = "×";
            remove.title = "stop asking " + item;
            remove.onclick = async () => {
                await api("/questions?phrase=" + encodeURIComponent(item), { method: "DELETE" });
                pinNote.textContent = "no longer asking " + item;
            };
            pin.append(remove);
        }
        interests.append(pin);
    }
    if (sorted.length > defaults.length) {
        pinNote.textContent = "the plain ones were added by something and go away on a restart"
            + " unless whatever added them asks again.";
    }
}

function connect() {
    const query = password ? "/?password=" + encodeURIComponent(password) : "";
    const socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + query);
    socket.onopen = () => link.classList.remove("down");
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === "init") {
            rows.replaceChildren();
            shown.length = 0;
            // Oldest first into a list that prepends, which leaves the newest on top.
            for (const entry of message.entries) {
                add(entry, false);
            }
        } else if (message.type === "cleared") {
            // The log those rows came from is gone, so keeping them on screen would be showing
            // history that no longer exists.
            rows.replaceChildren();
            shown.length = 0;
            showHistory();
        } else if (message.type === "entry") {
            add(message.entry, true);
        }
        setState(message.state);
    };
    // Reconnecting rather than reloading keeps whatever is already on screen while the link is down.
    socket.onclose = event => {
        link.classList.add("down");
        // 401 comes back as an abnormal close with no useful code, so a socket that will not open
        // while a password is set is treated as the password being wrong.
        if (event.code === 1006 && !password) {
            askForPassword("this needs a password");
            return;
        }
        setTimeout(connect, 1000);
    };
    socket.onerror = () => socket.close();
}
showPasswordState();
showResolution();
showHistory();
showComparison();
// While a run is going the button carries its progress, so it is refreshed rather than left stale.
setInterval(() => { if (compareButton.className === "picked") { showComparison(); } }, 15000);
setView(everything);
connect();
</script>`;

async function main() {
    const args = process.argv.slice(2);
    let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    let index = DEFAULT_INDEX;
    for (let position = 0; position < args.length; position++) {
        if (args[position] === "--every") {
            intervalSeconds = Number(args[++position]);
        } else if (args[position] === "--index") {
            index = Number(args[++position]);
        } else {
            console.error(`Unknown argument ${args[position]}; known are --every and --index`);
            process.exit(1);
        }
    }

    const recorder = new Recorder(index);

    // Re-read per request, so setting or clearing a password takes effect without a restart.
    const authorised = (request: http.IncomingMessage, url: URL) =>
        passwordMatches(readPassword(PASSWORD_FILE), offeredPassword(request.headers.authorization, url));

    const server = http.createServer((request, response) => {
        const url = new URL(request.url ?? "/", `http://${HOST}:${PORT}`);
        // Before anything else, including the page. Somebody outside the network gets nothing at all,
        // so a forwarded port exposes nothing rather than exposing a login.
        if (!isLocalAddress(request.socket.remoteAddress)) {
            log(`refused ${request.socket.remoteAddress}, which is not on this network`);
            response.writeHead(403, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: "Only the local network may connect" }));
            return;
        }
        // The page itself is served to anyone, because it is the thing that asks for the password.
        // Gating it meant a browser with no password got a 401 body of json and no way to get past
        // it: there was nothing loaded to do the asking. The page holds no camera data of its own,
        // and every request it then makes is checked like any other.
        if (url.pathname === "/") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(PAGE);
            return;
        }
        if (!authorised(request, url)) {
            response.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
            response.end(JSON.stringify({ error: "A password is required" }));
            return;
        }
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
        if (url.pathname === "/comparison") {
            const send = (status: number, payload: Record<string, unknown>) => {
                response.writeHead(status, { "Content-Type": "application/json" });
                response.end(JSON.stringify(payload));
            };
            if (request.method !== "POST") {
                send(200, recorder.comparisonState());
                return;
            }
            void (async () => {
                try {
                    const parsed = JSON.parse(await readBody(request)) as { enabled?: unknown };
                    send(200, parsed.enabled ? await recorder.startComparison() : recorder.stopComparison());
                } catch (error) {
                    send(400, { error: (error as Error).message });
                }
            })();
            return;
        }
        if (url.pathname === "/comparisons") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ runs: listRuns(COMPARISON_DIRECTORY) }));
            return;
        }
        if (url.pathname.startsWith("/comparisons/")) {
            // Only ever a single path segment, so a crafted name cannot walk out of the directory.
            const rest = url.pathname.slice("/comparisons/".length).split("/");
            const run = path.basename(decodeURIComponent(rest[0] ?? ""));
            const directory = runDirectory(COMPARISON_DIRECTORY, run);
            if (!run || !fs.existsSync(directory)) {
                response.writeHead(404, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: "no such run" }));
                return;
            }
            if (rest[1] === "frames" && rest[2]) {
                const frame = path.join(directory, "frames", path.basename(decodeURIComponent(rest[2])));
                if (!fs.existsSync(frame)) {
                    response.writeHead(404).end("no such frame");
                    return;
                }
                response.writeHead(200, { "Content-Type": "image/jpeg" });
                fs.createReadStream(frame).pipe(response);
                return;
            }
            try {
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify(readRun(COMPARISON_DIRECTORY, run)));
            } catch (error) {
                response.writeHead(500, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: (error as Error).message }));
            }
            return;
        }
        // The raw lines, for anything that wants to do its own arithmetic. They are small: a day of
        // this is tens of kilobytes, because only changes and a minute heartbeat are written.
        if (url.pathname === "/history" && request.method === "DELETE") {
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(recorder.clearHistory()));
            return;
        }
        if (url.pathname === "/history") {
            const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
            const { events, days: names } = readHistory(LOG_DIRECTORY, days);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ days: names, events }));
            return;
        }
        if (url.pathname === "/stats") {
            const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") ?? 7)));
            const { events, days: names } = readHistory(LOG_DIRECTORY, days);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify(summarise(events, names)));
            return;
        }
        // eye2 owns the setting and only listens on loopback, so this is the way to it from a phone.
        if (url.pathname === "/resolution") {
            void (async () => {
                try {
                    const forwarded = request.method === "POST"
                        ? await fetch(`${EYE2_URL}/resolution`, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: await readBody(request),
                            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                        })
                        : await fetch(`${EYE2_URL}/resolution`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
                    const body = await forwarded.text();
                    response.writeHead(forwarded.status, { "Content-Type": "application/json" });
                    response.end(body);
                } catch (error) {
                    response.writeHead(502, { "Content-Type": "application/json" });
                    response.end(JSON.stringify({ error: `eye2 is not answering: ${(error as Error).message}` }));
                }
            })();
            return;
        }
        if (url.pathname === "/password") {
            const send = (status: number, payload: Record<string, unknown>) => {
                response.writeHead(status, { "Content-Type": "application/json" });
                response.end(JSON.stringify(payload));
            };
            // Only ever says whether one is set. Reaching here at all means the current one was
            // accepted, or that there is none, so no further check is needed to change it.
            if (request.method === "GET") {
                send(200, { set: readPassword(PASSWORD_FILE) !== undefined });
                return;
            }
            if (request.method === "POST") {
                let body = "";
                request.on("data", chunk => {
                    body += chunk;
                    if (body.length > 4096) {
                        request.destroy();
                    }
                });
                request.on("end", () => {
                    try {
                        const parsed = JSON.parse(body) as { password?: unknown };
                        const wanted = String(parsed.password ?? "");
                        writePassword(PASSWORD_FILE, wanted);
                        log(wanted ? `the password was changed` : `the password was removed`);
                        send(200, { set: wanted.length > 0 });
                    } catch (error) {
                        send(400, { error: (error as Error).message });
                    }
                });
                return;
            }
            send(405, { error: `Use GET or POST on /password` });
            return;
        }
        if (url.pathname === "/questions") {
            const send = (status: number, payload: Record<string, unknown>) => {
                response.writeHead(status, { "Content-Type": "application/json" });
                response.end(JSON.stringify(payload));
            };
            if (request.method === "GET") {
                send(200, {
                    watches: recorder.listWatches(),
                    phrases: recorder.listPhrases(),
                    defaults: DEFAULT_WATCHES.map(watch => watch.phrase),
                });
                return;
            }
            if (request.method === "DELETE") {
                // In the query rather than the body, so it can be removed with a plain curl -X DELETE.
                const wanted = url.searchParams.get("phrase") ?? url.searchParams.get("question") ?? "";
                const remaining = recorder.removeWatch(wanted);
                send(200, { watches: remaining, phrases: remaining.map(watch => watch.phrase) });
                return;
            }
            if (request.method === "POST") {
                let body = "";
                request.on("data", chunk => {
                    body += chunk;
                    if (body.length > MAX_PHRASE_LENGTH * 8) {
                        request.destroy();
                    }
                });
                request.on("end", () => {
                    try {
                        // "question" is still read, since the older name is what anything watching a
                        // default was already sending and those keep working unchanged.
                        const parsed = JSON.parse(body) as { phrase?: unknown; question?: unknown };
                        const wanted = String(parsed.phrase ?? parsed.question ?? "");
                        const watches = recorder.addWatch(wanted);
                        send(200, { watches, phrases: watches.map(watch => watch.phrase) });
                    } catch (error) {
                        send(400, { error: (error as Error).message });
                    }
                });
                return;
            }
            send(405, { error: `Use GET, POST or DELETE on /questions` });
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
        response.writeHead(404).end("not found");
    });

    // One round is a couple of hundred bytes, so pushing them beats a page that reloads itself and
    // rebuilds a few hundred rows to learn that one was added.
    const sockets = new WebSocketServer({
        server,
        // Checked at the handshake, so an unauthorised socket is never established rather than being
        // established and then policed.
        verifyClient: ({ req }, done) => {
            if (!isLocalAddress(req.socket.remoteAddress)) {
                done(false, 403, "Only the local network may connect");
                return;
            }
            const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
            done(authorised(req, url), 401, "A password is required");
        },
    });
    sockets.on("connection", (socket: WebSocket) => {
        socket.send(JSON.stringify({ type: "init", entries: recorder.entriesSince(0, BACKLOG_LIMIT), state: recorder.state }));
        const stop = recorder.listen((entry, cleared) => {
            if (socket.readyState !== socket.OPEN) {
                return;
            }
            // No entry means the questions changed rather than a round landing, so subscribers
            // get the new state without a fabricated round to go with it. Cleared is its own kind,
            // because a page holding rows for a log that no longer exists should drop them.
            socket.send(entry
                ? JSON.stringify({ type: "entry", entry, state: recorder.state })
                : JSON.stringify({ type: cleared ? "cleared" : "state", state: recorder.state }));
        });
        socket.on("close", stop);
        socket.on("error", stop);
    });

    server.listen(PORT, HOST, () => {
        log(`serving the action log on http://${HOST}:${PORT}`);
        log(`  /        the page, fed over a websocket`);
        log(`  /log     json, ?since=<ms epoch>&limit=<n>`);
        log(`  /status  rounds and the scene the model is working from`);
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

    log(`asking camera ${index} ${intervalSeconds > 0 ? `every ${intervalSeconds}s` : `back to back`}`);
    while (true) {
        const startedAtMs = Date.now();
        const answered = await recorder.round();
        // A failed round returns in milliseconds, so with no interval set this loop would spin at the
        // speed of the failure: thousands of requests and log lines a minute while the model is down,
        // which is what it did while llama.cpp was wedged. Backing off keeps a broken model quiet and
        // leaves the log readable enough to see why it broke.
        const waitMs = answered ? intervalSeconds * 1000 : FAILURE_BACKOFF_MS;
        const remainingMs = waitMs - (Date.now() - startedAtMs);
        if (remainingMs > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingMs));
        }
    }
}

main().catch(error => {
    console.error(`[actions] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
