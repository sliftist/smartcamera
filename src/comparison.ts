import * as fs from "fs";
import * as path from "path";
import { PRESETS } from "./imageBudget";
import { millisecondStamp, secondStamp } from "./timestamps";

/**
 * Asking every frame twice, at the size in use and at the next size down, to find out what the
 * smaller one gets wrong.
 *
 * The interesting question about resolution is not how fast each size is, which is easy to measure,
 * but what the cheaper one stops noticing. That only shows up on real frames from the actual room,
 * and only on the frames where the two disagree, which are rare enough to be worth keeping whole.
 *
 * Both answers come from the same captured frame. Asking twice over two requests would give each its
 * own frame and then every disagreement would be the room having moved, which is the one thing this
 * must not measure.
 *
 * A run costs roughly double, so it is not something to leave on: it stops on its own after an hour.
 */

export const RUN_LIMIT_MS = 60 * 60 * 1000;

export type Deviation = {
    at: number;
    /** What each size said was true. */
    higher: string[];
    lower: string[];
    /** The questions they disagreed about, which is the whole point of the record. */
    differ: string[];
    frame?: string;
};

export type RunSummary = {
    run: string;
    startedAt: number;
    /** Rounds compared, and how many of them disagreed at all. */
    rounds: number;
    deviations: number;
    higher: { width: number; height: number };
    lower: { width: number; height: number };
    /** Per question: how often the smaller size differed, and which way it went. */
    byQuestion: { question: string; differed: number; missedByLower: number; extraInLower: number }[];
};

/** The next size down from whatever is in use, or nothing if it is already the smallest. */
export function nextSizeDown(current: { width: number; height: number }): { width: number; height: number } | undefined {
    const area = current.width * current.height;
    const smaller = PRESETS.filter(preset => preset.width * preset.height < area)
        .sort((left, right) => right.width * right.height - left.width * left.height);
    return smaller[0];
}

export function runDirectory(root: string, run: string): string {
    return path.join(root, run);
}

export class ComparisonRun {
    readonly run: string;
    readonly startedAt = Date.now();
    readonly endsAt = this.startedAt + RUN_LIMIT_MS;
    rounds = 0;
    deviations = 0;
    private file: string;

    constructor(
        private root: string,
        readonly higher: { width: number; height: number },
        readonly lower: { width: number; height: number },
    ) {
        this.run = secondStamp(this.startedAt);
        fs.mkdirSync(path.join(runDirectory(root, this.run), "frames"), { recursive: true });
        // Written synchronously, one append per deviation. They are rare by construction, since only
        // disagreements are kept, and a buffered stream would mean a run that has just been stopped
        // still reads as empty for a moment, which is exactly when someone goes to look at it.
        this.file = path.join(runDirectory(root, this.run), "deviations.jsonl");
        fs.appendFileSync(this.file, "");
        this.writeMeta();
    }

    private writeMeta() {
        fs.writeFileSync(path.join(runDirectory(this.root, this.run), "run.json"), JSON.stringify({
            run: this.run,
            startedAt: this.startedAt,
            higher: this.higher,
            lower: this.lower,
        }, undefined, 2));
    }

    get expired(): boolean {
        return Date.now() >= this.endsAt;
    }

    /**
     * One compared round. Only disagreements are written, along with the frame that caused them,
     * because a run where the two sizes agree all afternoon has nothing in it worth keeping.
     */
    record(at: number, higher: string[], lower: string[], frameJpeg: string | undefined) {
        this.rounds++;
        const differ = [...new Set([...higher, ...lower])]
            .filter(question => higher.includes(question) !== lower.includes(question))
            .sort();
        if (differ.length === 0) {
            return;
        }
        this.deviations++;
        const deviation: Deviation = { at, higher, lower, differ };
        if (frameJpeg) {
            const name = `${millisecondStamp(at)}.jpg`;
            try {
                fs.writeFileSync(path.join(runDirectory(this.root, this.run), "frames", name), Buffer.from(frameJpeg, "base64"));
                deviation.frame = name;
            } catch {
                // A frame that will not write is not a reason to lose the record of the deviation.
            }
        }
        fs.appendFileSync(this.file, JSON.stringify(deviation) + "\n");
    }

    close() {
        fs.writeFileSync(path.join(runDirectory(this.root, this.run), "run.json"), JSON.stringify({
            run: this.run,
            startedAt: this.startedAt,
            stoppedAt: Date.now(),
            rounds: this.rounds,
            deviations: this.deviations,
            higher: this.higher,
            lower: this.lower,
        }, undefined, 2));
    }
}

export function listRuns(root: string): string[] {
    try {
        return fs.readdirSync(root)
            .filter(name => fs.existsSync(path.join(root, name, "deviations.jsonl")))
            .sort()
            .reverse();
    } catch {
        return [];
    }
}

export function readRun(root: string, run: string): { summary: RunSummary; deviations: Deviation[] } {
    const directory = runDirectory(root, run);
    const meta = JSON.parse(fs.readFileSync(path.join(directory, "run.json"), "utf8"));
    const deviations: Deviation[] = [];
    for (const line of fs.readFileSync(path.join(directory, "deviations.jsonl"), "utf8").split("\n")) {
        if (!line.trim()) {
            continue;
        }
        try {
            deviations.push(JSON.parse(line) as Deviation);
        } catch {
            // A half written last line, from a run that was still going when this was read.
        }
    }

    // Which way each disagreement went matters more than how many there were. A question the smaller
    // size keeps missing is a reason not to use it; one it keeps inventing is a different problem.
    const differed = new Map<string, { differed: number; missedByLower: number; extraInLower: number }>();
    for (const deviation of deviations) {
        for (const question of deviation.differ) {
            const tally = differed.get(question) ?? { differed: 0, missedByLower: 0, extraInLower: 0 };
            tally.differed++;
            if (deviation.higher.includes(question)) {
                tally.missedByLower++;
            } else {
                tally.extraInLower++;
            }
            differed.set(question, tally);
        }
    }

    return {
        summary: {
            run,
            startedAt: meta.startedAt ?? 0,
            rounds: meta.rounds ?? deviations.length,
            deviations: deviations.length,
            higher: meta.higher,
            lower: meta.lower,
            byQuestion: [...differed.entries()]
                .map(([question, tally]) => ({ question, ...tally }))
                .sort((left, right) => right.differed - left.differed),
        },
        deviations,
    };
}
