import * as fs from "fs";
import * as path from "path";
import { extractClipFrames, selectFrames, ClipFrames } from "./clipFrames";

/**
 * Watches the door clips as they arrive and decides whether each one is a delivery.
 *
 * A clip is judged from a handful of its frames, chosen for being the ones where somebody was
 * actually in the hallway, each asked one question at a modest size. Those three choices, one frame
 * a second, the peak frames only, and 768x432, were each measured against every hand labelled clip
 * and each still finds all thirty deliveries; together they take a clip from minutes to seconds.
 *
 * The frames are asked about one at a time and only when the caller says it is this worker's turn.
 * The camera in the room is live and this is not, so the room goes first and a delivery clip fills
 * the gaps between rounds rather than competing for them.
 */

/** Only clips with at least this much movement are fetched at all, so this is the floor here too. */
export const DELIVERY_PROMPT = `This is a hallway outside apartment doors, seen from a camera above one of them.\n`
    + `Answer yes if any of these is true of this image:\n`
    + `- a cardboard box, parcel, package or padded envelope is on the floor or against a door\n`
    + `- a person is carrying a cardboard box, parcel, package or padded envelope\n`
    + `- a person is carrying an insulated food delivery bag\n`
    + `- a person is wearing a high visibility vest or a delivery uniform\n`
    + `- a person is crouching or bending down to put something on the floor near a door\n`
    + `- a person is holding up a phone and reading it while walking down the hallway\n`
    + `Answer no if the only thing in the image is an empty hallway, or a person carrying nothing,`
    + ` or a person carrying a backpack, handbag, purse, shoulder bag, suitcase or shopping.\n`
    + `Answer with one word, yes or no.`;
/** Measured: the smallest size that still finds every labelled delivery. Below it one goes under. */
export const DELIVERY_WIDTH = 768;
export const DELIVERY_HEIGHT = 432;
const MAX_NEW_TOKENS = 4;
const CLIP_NAME = /_(\d+)\.mp4$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** How often to look for clips the sync daemon has added. */
const SCAN_MS = 15 * 1000;
/** Clips older than this at startup are not judged: the person has long since gone. */
const CATCH_UP_MS = 6 * 60 * 60 * 1000;
/**
 * One line per clip judged, appended forever, beside the clips.
 *
 * The verdict beside each clip is what stops it being judged twice; this is the same facts in one
 * place, in order, so the whole history reads as a single file rather than a find across day
 * folders. Clips that could not be read are written here too, since a clip that silently vanished
 * from the record would be the hardest kind of miss to notice.
 */
const LEDGER = "verdicts.jsonl";

/** One frame's answer, kept whole. The raw text is what lets a wrong verdict be understood later. */
export type FrameAnswer = { frame: string; answer: string; yes: boolean; ms: number };

/**
 * Everything about how a clip was judged, not just the judgement.
 *
 * There will only ever be a handful of clips a day and very few deliveries among them, so there is
 * no chance to debug this by watching it happen. Each verdict therefore carries the whole story:
 * how many frames the clip had, which ones were chosen, and exactly what the model said about each
 * one that was asked, in order. A miss can then be traced to a frame that was never chosen or a
 * frame that was chosen and answered wrongly, which are different fixes.
 */
export type Verdict = {
    clip: string;
    /** The clip's peak time, its identity everywhere else. */
    t: number;
    delivery: boolean;
    /** The frame that decided it, when it was a delivery. */
    frame?: string;
    /** How many frames the clip had, one a second. */
    frames: number;
    /** The frames chosen to be asked about, whether or not all were reached. */
    selected: string[];
    /** Every frame actually asked, in order, with what came back. */
    answers: FrameAnswer[];
    asked: number;
    at: number;
};

type Pending = {
    day: string;
    file: string;
    t: number;
    frames: ClipFrames;
    /** Indices into frames still to be asked about, in order. */
    remaining: number[];
    selected: string[];
    answers: FrameAnswer[];
    asked: number;
};

/** Anything that is not clearly a no is treated as a yes, since a miss is the expensive mistake. */
function saidYes(answer: string): boolean {
    const word = answer.trim().toLowerCase().replace(/[^a-z]/g, "");
    return word.startsWith("y") || (!word.startsWith("n") && word.length > 0);
}

export class DeliveryWatcher {
    private queue: Pending[] = [];
    private current: Pending | undefined;
    /** Clips already judged or in hand, so a scan never picks one up twice. */
    private seen = new Set<number>();
    private scanning = false;
    private timer: ReturnType<typeof setInterval> | undefined;
    judged = 0;
    found = 0;

    constructor(
        private clipRoot: string,
        private frameRoot: string,
        private askImage: (jpeg: Buffer, prompt: string, width: number, height: number) => Promise<string>,
        private onVerdict: (verdict: Verdict) => void,
        private log: (message: string) => void,
    ) {}

    start() {
        // Anything already judged is remembered by its verdict file, so a restart does not redo it,
        // and anything older than the catch up window is left alone: nobody needs to be told about
        // a delivery from yesterday morning.
        void this.scan();
        this.timer = setInterval(() => void this.scan(), SCAN_MS);
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    /** True when there is a frame waiting to be asked about, which is when the caller should give a turn. */
    get busy(): boolean {
        return this.current !== undefined || this.queue.length > 0;
    }

    private verdictPath(day: string, file: string): string {
        return path.join(this.clipRoot, day, `${file.replace(/\.mp4$/, "")}.delivery.json`);
    }

    private async scan() {
        if (this.scanning) {
            return;
        }
        this.scanning = true;
        try {
            const since = Date.now() - CATCH_UP_MS;
            let days: string[];
            try {
                days = fs.readdirSync(this.clipRoot).filter(name => DAY_FOLDER.test(name)).sort().slice(-2);
            } catch {
                return;
            }
            for (const day of days) {
                for (const file of fs.readdirSync(path.join(this.clipRoot, day)).filter(name => CLIP_NAME.test(name)).sort()) {
                    const t = Number(CLIP_NAME.exec(file)![1]);
                    if (this.seen.has(t) || t < since) {
                        continue;
                    }
                    this.seen.add(t);
                    if (fs.existsSync(this.verdictPath(day, file))) {
                        continue;
                    }
                    await this.take(day, file, t);
                }
            }
        } catch (error) {
            this.log(`scanning for door clips failed: ${(error as Error).message}`);
        } finally {
            this.scanning = false;
        }
    }

    private async take(day: string, file: string, t: number) {
        const stem = file.replace(/\.mp4$/, "");
        const folder = path.join(this.frameRoot, day, stem);
        let frames: ClipFrames;
        try {
            if (fs.existsSync(path.join(folder, "done")) && fs.existsSync(path.join(folder, "frames.json"))) {
                frames = JSON.parse(fs.readFileSync(path.join(folder, "frames.json"), "utf8")) as ClipFrames;
            } else {
                const startedAtMs = Date.now();
                frames = await extractClipFrames(path.join(this.clipRoot, day, file), folder);
                this.log(`door clip ${day}/${file}: ${frames.frames.length} frames in ${Date.now() - startedAtMs}ms`);
            }
        } catch (error) {
            this.log(`door clip ${day}/${file} could not be read: ${(error as Error).message}`);
            // Written down, not just said. A clip that silently vanished from the record would be
            // the hardest kind of miss to ever notice.
            this.record({ clip: `${day}/${file}`, t, error: (error as Error).message, at: Date.now() });
            return;
        }
        const remaining = selectFrames(frames.grids);
        const selected = remaining.map(index => frames.frames[index]);
        this.log(`door clip ${day}/${file}: ${frames.frames.length} frames, asking about ${selected.join(" ")}`);
        this.queue.push({ day, file, t, frames, remaining, selected, answers: [], asked: 0 });
    }

    /** Appends one line to the ledger. Failing to write it is said, never allowed to stop a verdict. */
    private record(line: Record<string, unknown>) {
        try {
            fs.appendFileSync(path.join(this.clipRoot, LEDGER), `${JSON.stringify(line)}\n`);
        } catch (error) {
            this.log(`could not append to ${LEDGER}: ${(error as Error).message}`);
        }
    }

    /**
     * Asks about exactly one frame, then returns. Called by the room's loop between its own rounds,
     * so the two share the model turn about. Resolves to a verdict only when a clip is settled.
     */
    async turn(): Promise<Verdict | undefined> {
        if (!this.current) {
            this.current = this.queue.shift();
        }
        const clip = this.current;
        if (!clip) {
            return undefined;
        }
        const index = clip.remaining.shift();
        if (index === undefined) {
            return this.settle(clip, false);
        }
        const name = clip.frames.frames[index];
        const jpeg = fs.readFileSync(path.join(this.frameRoot, clip.day, clip.file.replace(/\.mp4$/, ""), name));
        clip.asked++;
        let answer: string;
        const startedAtMs = Date.now();
        try {
            answer = await this.askImage(jpeg, DELIVERY_PROMPT, DELIVERY_WIDTH, DELIVERY_HEIGHT);
        } catch (error) {
            // The frame goes back on the front of the queue. A model that is down is not a no.
            clip.remaining.unshift(index);
            clip.asked--;
            this.log(`door clip ${clip.day}/${clip.file}: asking failed, will retry: ${(error as Error).message}`);
            return undefined;
        }
        const yes = saidYes(answer);
        // Every answer, verbatim, one line each. There are few enough clips that this is cheap and
        // few enough deliveries that it is the only record of what the model actually said.
        clip.answers.push({ frame: name, answer, yes, ms: Date.now() - startedAtMs });
        this.log(`door clip ${clip.day}/${clip.file}: ${name} -> ${JSON.stringify(answer)}`
            + ` (${yes ? "yes" : "no"}, ${Date.now() - startedAtMs}ms)`);
        if (yes) {
            // One frame is enough. Everything after it could only agree.
            return this.settle(clip, true, name);
        }
        if (clip.remaining.length === 0) {
            return this.settle(clip, false);
        }
        return undefined;
    }

    private settle(clip: Pending, delivery: boolean, frame?: string): Verdict {
        this.current = undefined;
        const verdict: Verdict = {
            clip: `${clip.day}/${clip.file}`,
            t: clip.t,
            delivery,
            frame,
            frames: clip.frames.frames.length,
            selected: clip.selected,
            answers: clip.answers,
            asked: clip.asked,
            at: Date.now(),
        };
        try {
            fs.writeFileSync(this.verdictPath(clip.day, clip.file), `${JSON.stringify(verdict)}\n`);
        } catch (error) {
            this.log(`could not record the verdict for ${verdict.clip}: ${(error as Error).message}`);
        }
        this.record(verdict);
        this.judged++;
        if (delivery) {
            this.found++;
        }
        this.log(`door clip ${verdict.clip}: ${delivery ? `DELIVERY at frame ${frame}` : "not a delivery"}`
            + ` after ${clip.asked} frame${clip.asked === 1 ? "" : "s"}`);
        this.onVerdict(verdict);
        return verdict;
    }
}
