import * as fs from "fs";
import * as path from "path";
import { dayStamp } from "./timestamps";

const POLL_INTERVAL_MS = 500;
const DAY_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.md$/;

// "2026/08/01 10:41:27 PM"
const TIME_PATTERN = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) (AM|PM)/;
// "**person** 89%"
const SCORE_PATTERN = /\*\*([^*]+)\*\* (\d+)%/g;
// "person[400,203 1454x876]"
const BOX_PATTERN = /([a-z][a-z ]*)\[(-?\d+),(-?\d+) (\d+)x(\d+)\]/g;

export type LoggedDetection = {
    className: string;
    score: number;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type LoggedFrame = {
    time: number;
    detections: LoggedDetection[];
    line: string;
};

export function parseLine(line: string): LoggedFrame | undefined {
    const time = TIME_PATTERN.exec(line);
    if (!time) {
        return undefined;
    }
    const [, year, month, day, rawHours, minutes, seconds, meridiem] = time;
    let hours = parseInt(rawHours, 10) % 12;
    if (meridiem === "PM") {
        hours += 12;
    }
    const timestamp = new Date(parseInt(year, 10), parseInt(month, 10) - 1, parseInt(day, 10), hours, parseInt(minutes, 10), parseInt(seconds, 10)).getTime();

    const scores = [...line.matchAll(SCORE_PATTERN)].map(match => ({ className: match[1], score: parseInt(match[2], 10) / 100 }));
    const boxes = [...line.matchAll(BOX_PATTERN)].map(match => ({
        className: match[1],
        x: parseInt(match[2], 10),
        y: parseInt(match[3], 10),
        width: parseInt(match[4], 10),
        height: parseInt(match[5], 10),
    }));

    // The two lists are written in the same order, so the box for a detection is the one at its index.
    const detections = scores.map((score, index) => ({
        className: score.className,
        score: score.score,
        x: boxes[index]?.x ?? 0,
        y: boxes[index]?.y ?? 0,
        width: boxes[index]?.width ?? 0,
        height: boxes[index]?.height ?? 0,
    }));
    return { time: timestamp, detections, line };
}

async function latestDayFile(directory: string): Promise<string | undefined> {
    const entries = await fs.promises.readdir(directory);
    const days = entries.filter(entry => DAY_FILE_PATTERN.test(entry)).sort();
    return days[days.length - 1];
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/**
 * Yields each detection line as it is appended, reading only the bytes that were added rather than
 * rescanning the file. Starts at the end of the newest day file, so only live frames are reported.
 */
export async function* watchDetections(directory: string): AsyncGenerator<LoggedFrame> {
    let name: string | undefined;
    while (!name) {
        name = await latestDayFile(directory);
        if (!name) {
            console.log(`[autopause] waiting for a detection log to appear in ${directory}`);
            await delay(POLL_INTERVAL_MS);
        }
    }

    let handle = await fs.promises.open(path.join(directory, name), "r");
    let position = (await handle.stat()).size;
    let remainder = "";
    console.log(`[autopause] following ${name} from byte ${position}`);

    while (true) {
        await delay(POLL_INTERVAL_MS);

        // The recorder starts a new file at midnight, so follow it across the rollover.
        const expected = `${dayStamp(Date.now())}.md`;
        if (expected !== name) {
            const expectedPath = path.join(directory, expected);
            const exists = await fs.promises.stat(expectedPath).then(() => true).catch(() => false);
            if (exists) {
                await handle.close();
                handle = await fs.promises.open(expectedPath, "r");
                position = 0;
                remainder = "";
                name = expected;
                console.log(`[autopause] following ${name} after the day rolled over`);
            }
        }

        const size = (await handle.stat()).size;
        if (size < position) {
            position = 0;
            remainder = "";
        }
        if (size === position) {
            continue;
        }

        const buffer = Buffer.alloc(size - position);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        position += bytesRead;
        remainder += buffer.subarray(0, bytesRead).toString("utf8");

        const lines = remainder.split("\n");
        remainder = lines.pop() || "";
        for (const line of lines) {
            const frame = parseLine(line);
            if (frame) {
                yield frame;
            }
        }
    }
}
