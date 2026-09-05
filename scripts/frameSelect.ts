import * as fs from "fs";
import * as path from "path";
import { ClipStats, statsPath } from "./frameStats";

/**
 * Which frames are worth asking the model about.
 *
 * Asking about every frame of every clip is 12,884 questions at about 700ms each, which is two and a
 * half hours. Almost all of those frames are an empty hallway, and a delivery matches on many frames
 * in a row rather than on one, so most of that work is spent confirming nothing over and over.
 *
 * A rule here is judged on one thing: does the handful of frames it picks still include at least one
 * frame the model said yes to? That is checked against the cached full pass, so no model is run and
 * every rule is measured against exactly the same answers.
 *
 * The camera never moves, so the empty hallway is the same picture every time and the useful signal
 * is simply how far a frame is from it. That is the whole idea behind most of what is tried below.
 */

const CLIP_ROOT = path.join(__dirname, "..", "doorclips");
const CACHE = path.join(__dirname, "..", "state", "eval", "strict-896x504.json");
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

type Cached = { clips: { clip: string; delivery: boolean; frames: number; hits: string[] }[] };

/** Per pixel median across the clip: what this hallway looks like with nobody in it. */
function background(grids: number[][]): number[] {
    const out = new Array(grids[0].length).fill(0);
    const column: number[] = new Array(grids.length);
    for (let cell = 0; cell < out.length; cell++) {
        for (let i = 0; i < grids.length; i++) {
            column[i] = grids[i][cell];
        }
        column.sort((left, right) => left - right);
        out[cell] = column[Math.floor(column.length / 2)];
    }
    return out;
}

function meanAbsolute(a: number[], b: number[]): number {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += Math.abs(a[i] - b[i]);
    }
    return sum / a.length;
}

/** How far each frame is from the empty hallway, and from the frame before it. */
function scores(grids: number[][]): { fromEmpty: number[]; fromPrevious: number[] } {
    const empty = background(grids);
    const fromEmpty = grids.map(grid => meanAbsolute(grid, empty));
    const fromPrevious = grids.map((grid, at) => at === 0 ? 0 : meanAbsolute(grid, grids[at - 1]));
    return { fromEmpty, fromPrevious };
}

function topBy(values: number[], count: number): number[] {
    return values
        .map((value, at) => ({ value, at }))
        .sort((left, right) => right.value - left.value)
        .slice(0, count)
        .map(item => item.at)
        .sort((left, right) => left - right);
}

/**
 * The peak of each stretch of activity.
 *
 * Somebody walking through gives one continuous run of frames unlike the empty hallway, and the
 * middle of that run is where they are most visible. Taking the strongest frame of each run, rather
 * than the strongest frames overall, is what stops a single long visit from using up the whole
 * budget while a second, briefer one gets nothing.
 */
function runPeaks(values: number[], share: number, perRun: number): number[] {
    const highest = Math.max(...values);
    if (highest <= 0) {
        return [0];
    }
    const floor = highest * share;
    const picked: number[] = [];
    let at = 0;
    while (at < values.length) {
        if (values[at] < floor) {
            at++;
            continue;
        }
        let end = at;
        while (end + 1 < values.length && values[end + 1] >= floor) {
            end++;
        }
        // Spread across the run rather than clustered at its peak, since a courier can be plainly
        // visible at the start of a visit and hidden behind a door by the end of it.
        for (let i = 0; i < perRun; i++) {
            const where = Math.round(at + ((end - at) * (i + 0.5)) / perRun);
            if (!picked.includes(where)) {
                picked.push(where);
            }
        }
        at = end + 1;
    }
    return picked.length > 0 ? picked.sort((left, right) => left - right) : [topBy(values, 1)[0]];
}

type Strategy = { name: string; pick: (clip: ClipStats) => number[] };

/**
 * The rules worth using, by name, for anything that wants to select frames rather than compare rules.
 *
 * Two of them, because there are two honest answers. "peaks" is the leanest rule that still finds
 * every delivery, and "safe" spends about half as much again to make sure no delivery is found by a
 * single frame. Which to use depends on how much a miss costs, and here it costs a lot.
 */
export const SELECTORS: Record<string, (grids: number[][]) => number[]> = {
    peaks: grids => runPeaks(scores(grids).fromEmpty, 0.35, 2),
    safe: grids => {
        const { fromEmpty, fromPrevious } = scores(grids);
        return [...new Set([...runPeaks(fromEmpty, 0.35, 2), ...topBy(fromPrevious, 2)])]
            .sort((left, right) => left - right);
    },
};

const STRATEGIES: Strategy[] = [
    { name: "every frame", pick: clip => clip.frames.map((_, at) => at) },
    { name: "every 2nd", pick: clip => clip.frames.map((_, at) => at).filter(at => at % 2 === 0) },
    { name: "every 4th", pick: clip => clip.frames.map((_, at) => at).filter(at => at % 4 === 0) },
    { name: "every 8th", pick: clip => clip.frames.map((_, at) => at).filter(at => at % 8 === 0) },
    { name: "busiest 1", pick: clip => topBy(scores(clip.grids).fromEmpty, 1) },
    { name: "busiest 2", pick: clip => topBy(scores(clip.grids).fromEmpty, 2) },
    { name: "busiest 3", pick: clip => topBy(scores(clip.grids).fromEmpty, 3) },
    { name: "busiest 4", pick: clip => topBy(scores(clip.grids).fromEmpty, 4) },
    { name: "busiest 6", pick: clip => topBy(scores(clip.grids).fromEmpty, 6) },
    { name: "most movement 3", pick: clip => topBy(scores(clip.grids).fromPrevious, 3) },
    { name: "most movement 6", pick: clip => topBy(scores(clip.grids).fromPrevious, 6) },
    { name: "run peaks 50% x1", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.5, 1) },
    { name: "run peaks 50% x2", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.5, 2) },
    { name: "run peaks 35% x2", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.35, 2) },
    { name: "run peaks 35% x3", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.35, 3) },
    { name: "run peaks 25% x3", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.25, 3) },
    { name: "run peaks 25% x4", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.25, 4) },
    { name: "run peaks 20% x2", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.2, 2) },
    { name: "run peaks 35% x4", pick: clip => runPeaks(scores(clip.grids).fromEmpty, 0.35, 4) },
    // Longer clips hold more separate comings and goings, so a fixed budget starves them while
    // spending the same on a clip where nothing happens at all.
    {
        name: "busiest, by length",
        pick: clip => topBy(scores(clip.grids).fromEmpty, Math.max(3, Math.round(clip.frames.length / 6))),
    },
    {
        name: "peaks + busiest 2",
        pick: clip => {
            const { fromEmpty } = scores(clip.grids);
            return [...new Set([...runPeaks(fromEmpty, 0.35, 2), ...topBy(fromEmpty, 2)])]
                .sort((left, right) => left - right);
        },
    },
    {
        name: "peaks + movement 2",
        pick: clip => {
            const { fromEmpty, fromPrevious } = scores(clip.grids);
            return [...new Set([...runPeaks(fromEmpty, 0.35, 2), ...topBy(fromPrevious, 2)])]
                .sort((left, right) => left - right);
        },
    },
];

function main() {
    const cached = JSON.parse(fs.readFileSync(CACHE, "utf8")) as Cached;
    const hitsByClip = new Map<string, Set<string>>();
    for (const row of cached.clips) {
        if (row.delivery) {
            hitsByClip.set(row.clip, new Set(row.hits));
        }
    }

    // Every clip on disk, so the cost of a rule is its cost over the whole archive rather than over
    // the thirty deliveries, which are the cheap part.
    const all: ClipStats[] = [];
    for (const day of fs.readdirSync(CLIP_ROOT).filter(name => DAY_FOLDER.test(name)).sort()) {
        for (const file of fs.readdirSync(path.join(CLIP_ROOT, day)).filter(name => name.endsWith(".mp4")).sort()) {
            const stem = file.replace(/\.mp4$/, "");
            try {
                all.push(JSON.parse(fs.readFileSync(statsPath(day, stem), "utf8")) as ClipStats);
            } catch {
                // No frames were extracted for it.
            }
        }
    }
    const deliveries = all.filter(clip => hitsByClip.has(`${clip.clip.split("/")[0]}/${clip.clip.split("/")[1]}.mp4`));
    const totalFrames = all.reduce((sum, clip) => sum + clip.frames.length, 0);
    console.log(`${all.length} clips, ${totalFrames} frames, ${deliveries.length} deliveries with a cached answer\n`);
    console.log(`${"rule".padEnd(20)} ${"frames".padStart(7)} ${"of all".padStart(7)} ${"found".padStart(7)} ${"margin".padStart(7)}`);

    for (const strategy of STRATEGIES) {
        let picked = 0;
        let covered = 0;
        const margins: number[] = [];
        for (const clip of all) {
            const chosen = strategy.pick(clip);
            picked += chosen.length;
            const key = `${clip.clip.split("/")[0]}/${clip.clip.split("/")[1]}.mp4`;
            const hits = hitsByClip.get(key);
            if (!hits) {
                continue;
            }
            const landed = chosen.filter(at => hits.has(clip.frames[at])).length;
            if (landed > 0) {
                covered++;
            }
            margins.push(landed);
        }
        margins.sort((left, right) => left - right);
        console.log(`${strategy.name.padEnd(20)} ${String(picked).padStart(7)}`
            + ` ${((picked / totalFrames) * 100).toFixed(1).padStart(6)}%`
            + ` ${`${covered}/${deliveries.length}`.padStart(7)}`
            + ` ${String(margins[0] ?? 0).padStart(7)}`);
    }

    console.log(`\nfound = deliveries where at least one chosen frame was one the model said yes to`);
    console.log(`margin = the fewest such frames any single delivery had, so 1 means it only just held`);
}

// Only when run directly, so importing SELECTORS does not run the comparison.
if (require.main === module) {
    main();
}
