import * as fs from "fs";
import * as path from "path";
import { decode as decodeJpeg } from "jpeg-js";

/**
 * A tiny greyscale thumbnail of every extracted frame, cached to disk.
 *
 * This is the raw material for deciding which frames are worth asking the model about. Everything
 * that decision needs is about how much a frame differs from the empty hallway and from its
 * neighbours, and neither question needs pixels: a 32 by 18 grey thumbnail is 576 numbers and answers
 * both. Computed once and cached, so trying a dozen selection rules costs nothing after the first.
 */

const FRAME_ROOT = path.join(__dirname, "..", "doorframes");
const STATS_ROOT = path.join(__dirname, "..", "state", "framestats");
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** Small enough to be free to compare, large enough that a person at the far end still moves it. */
export const GRID_WIDTH = 32;
export const GRID_HEIGHT = 18;

export type ClipStats = {
    clip: string;
    frames: string[];
    /** One row per frame, each GRID_WIDTH * GRID_HEIGHT greys, 0 to 255. */
    grids: number[][];
};

export function statsPath(day: string, stem: string): string {
    return path.join(STATS_ROOT, day, `${stem}.json`);
}

function gridOf(file: string): number[] {
    const raw = decodeJpeg(fs.readFileSync(file), { useTArray: true });
    const grid = new Array(GRID_WIDTH * GRID_HEIGHT).fill(0);
    const counts = new Array(GRID_WIDTH * GRID_HEIGHT).fill(0);
    for (let y = 0; y < raw.height; y++) {
        const gy = Math.min(GRID_HEIGHT - 1, Math.floor((y * GRID_HEIGHT) / raw.height));
        for (let x = 0; x < raw.width; x++) {
            const gx = Math.min(GRID_WIDTH - 1, Math.floor((x * GRID_WIDTH) / raw.width));
            const at = (y * raw.width + x) * 4;
            // Rounded luma. Colour says nothing useful about whether somebody is standing there.
            const grey = (raw.data[at] * 299 + raw.data[at + 1] * 587 + raw.data[at + 2] * 114) / 1000;
            const cell = gy * GRID_WIDTH + gx;
            grid[cell] += grey;
            counts[cell]++;
        }
    }
    for (let i = 0; i < grid.length; i++) {
        grid[i] = counts[i] > 0 ? Math.round(grid[i] / counts[i]) : 0;
    }
    return grid;
}

function main() {
    const argv = process.argv.slice(2);
    const shardFlag = argv.indexOf("--shard");
    const [index, total] = shardFlag >= 0 ? argv[shardFlag + 1].split("/").map(Number) : [0, 1];

    const clips: { day: string; stem: string }[] = [];
    for (const day of fs.readdirSync(FRAME_ROOT).filter(name => DAY_FOLDER.test(name)).sort()) {
        for (const stem of fs.readdirSync(path.join(FRAME_ROOT, day)).sort()) {
            clips.push({ day, stem });
        }
    }
    const mine = clips.filter((_, at) => at % total === index);
    console.log(`shard ${index + 1}/${total}: ${mine.length} clips`);

    let done = 0;
    for (const { day, stem } of mine) {
        const target = statsPath(day, stem);
        if (fs.existsSync(target)) {
            done++;
            continue;
        }
        const folder = path.join(FRAME_ROOT, day, stem);
        const frames = fs.readdirSync(folder).filter(name => name.endsWith(".jpg")).sort();
        const grids = frames.map(name => gridOf(path.join(folder, name)));
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({ clip: `${day}/${stem}`, frames, grids }));
        done++;
        if (done % 25 === 0) {
            console.log(`  ${done} of ${mine.length}`);
        }
    }
    console.log(`shard ${index + 1} done: ${done} clips`);
}

// Only when run directly. Another script importing statsPath must not rebuild every descriptor.
if (require.main === module) {
    main();
}
