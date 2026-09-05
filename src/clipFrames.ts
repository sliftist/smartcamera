import * as fs from "fs";
import * as path from "path";
import { Demuxer, Decoder, SoftwareScaleContext, AVPixelFormat, AV_PIX_FMT_RGB24, SWS_BILINEAR } from "node-av";
import { encode as encodeJpeg } from "jpeg-js";

/**
 * One frame a second out of a door clip, as jpegs on disk beside a tiny grey thumbnail of each.
 *
 * Extracting is the expensive part of looking at a clip and it produces the same pixels every time,
 * so it is done once and the result kept. The thumbnails are what decides which of those frames are
 * worth asking the model about: that decision only needs to know how far a frame is from the empty
 * hallway, and a 32 by 18 grey grid answers that as well as the full picture would.
 *
 * Shared by the one off scripts that built the labelled set and by the daemon that now watches for
 * new clips, so both see exactly the same frames chosen the same way.
 */

export const GRID_WIDTH = 32;
export const GRID_HEIGHT = 18;
/** Kept at the camera's aspect, above what the model is shown, so the sample never limits it. */
const WIDTH = 1280;
const HEIGHT = 720;
const SECOND_MS = 1000;
const QUALITY = 88;

export type ClipFrames = {
    /** Frame file names, in order, one a second. */
    frames: string[];
    /** One per frame: GRID_WIDTH by GRID_HEIGHT greys, 0 to 255. */
    grids: number[][];
};

function gridOf(rgba: Buffer, width: number, height: number): number[] {
    const grid = new Array(GRID_WIDTH * GRID_HEIGHT).fill(0);
    const counts = new Array(GRID_WIDTH * GRID_HEIGHT).fill(0);
    for (let y = 0; y < height; y++) {
        const gy = Math.min(GRID_HEIGHT - 1, Math.floor((y * GRID_HEIGHT) / height));
        for (let x = 0; x < width; x++) {
            const gx = Math.min(GRID_WIDTH - 1, Math.floor((x * GRID_WIDTH) / width));
            const at = (y * width + x) * 4;
            const grey = (rgba[at] * 299 + rgba[at + 1] * 587 + rgba[at + 2] * 114) / 1000;
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

/**
 * Decodes a clip into `folder`, writing NNN.jpg per second plus a frames.json holding the grids and a
 * `done` marker last, so a folder without the marker is known to be incomplete rather than trusted.
 */
export async function extractClipFrames(clipFile: string, folder: string): Promise<ClipFrames> {
    const demuxer = await Demuxer.open(clipFile);
    const stream = demuxer.video();
    if (!stream) {
        throw new Error(`${clipFile} has no video stream`);
    }
    const timeBase = stream.timeBase;
    const decoder = await Decoder.create(stream);
    const scaler = new SoftwareScaleContext();
    let configured = "";
    let firstPts = -1;
    let nextAtMs = 0;
    const frames: string[] = [];
    const grids: number[][] = [];

    fs.mkdirSync(folder, { recursive: true });
    for await (const frame of decoder.frames(demuxer.packets(stream.index))) {
        if (!frame) {
            continue;
        }
        const pts = Number(frame.pts);
        if (firstPts < 0) {
            firstPts = pts;
        }
        const atMs = ((pts - firstPts) * timeBase.num * 1000) / timeBase.den;
        if (atMs + 1 < nextAtMs) {
            frame.free?.();
            continue;
        }
        nextAtMs = Math.floor(atMs / SECOND_MS) * SECOND_MS + SECOND_MS;

        const source = `${frame.width}x${frame.height}:${frame.format}`;
        if (configured !== source) {
            scaler.getContext(frame.width, frame.height, frame.format as AVPixelFormat, WIDTH, HEIGHT, AV_PIX_FMT_RGB24, SWS_BILINEAR);
            configured = source;
        }
        const rgb = Buffer.alloc(WIDTH * HEIGHT * 3);
        await scaler.scale(frame.data!, frame.linesize, 0, frame.height, [rgb], [WIDTH * 3]);
        const rgba = Buffer.alloc(WIDTH * HEIGHT * 4);
        for (let i = 0, at = 0; i < WIDTH * HEIGHT; i++) {
            rgba[at++] = rgb[i * 3];
            rgba[at++] = rgb[i * 3 + 1];
            rgba[at++] = rgb[i * 3 + 2];
            rgba[at++] = 255;
        }
        const name = `${String(Math.round(atMs / SECOND_MS)).padStart(3, "0")}.jpg`;
        fs.writeFileSync(path.join(folder, name), encodeJpeg({ data: rgba, width: WIDTH, height: HEIGHT }, QUALITY).data);
        frames.push(name);
        grids.push(gridOf(rgba, WIDTH, HEIGHT));
        frame.free?.();
    }
    try {
        demuxer.close?.();
    } catch {
        // Already closed, or never opened cleanly. Nothing further to release.
    }
    const result: ClipFrames = { frames, grids };
    fs.writeFileSync(path.join(folder, "frames.json"), JSON.stringify(result));
    fs.writeFileSync(path.join(folder, "done"), String(frames.length));
    return result;
}

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

function topBy(values: number[], count: number): number[] {
    return values
        .map((value, at) => ({ value, at }))
        .sort((left, right) => right.value - left.value)
        .slice(0, count)
        .map(item => item.at)
        .sort((left, right) => left - right);
}

/**
 * Two frames from each stretch of activity.
 *
 * Somebody walking through gives one continuous run of frames unlike the empty hallway. Two are
 * taken spread across each run rather than at its peak, since a courier can be plainly visible at
 * the start of a visit and hidden behind a door by the end of it. Per run rather than overall, so one
 * long visit cannot use up the whole budget while a briefer second one gets nothing.
 *
 * Measured against every hand labelled clip: this picks 8% of the frames and still lands on at least
 * one frame the model says yes to for all thirty deliveries.
 */
export function selectFrames(grids: number[][], share = 0.35, perRun = 2): number[] {
    if (grids.length === 0) {
        return [];
    }
    const empty = background(grids);
    const values = grids.map(grid => meanAbsolute(grid, empty));
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
