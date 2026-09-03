import * as fs from "fs";
import * as path from "path";
import { StreamTarget } from "./credentials";

const OUTPUT_ROOT = path.join(process.cwd(), "output");

/** Every camera gets its own folder, named after where the stream came from. */
export function outputDirectory(target: StreamTarget): string {
    return path.join(OUTPUT_ROOT, `${target.host}_${target.port}`);
}

export async function findOutputDirectory(): Promise<string> {
    const entries = await fs.promises.readdir(OUTPUT_ROOT, { withFileTypes: true }).catch(() => []);
    const names = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    if (names.length === 0) {
        throw new Error(`No camera folder under ${OUTPUT_ROOT}: run "yarn smart" first, or pass a directory`);
    }
    if (names.length > 1) {
        throw new Error(`${names.length} camera folders under ${OUTPUT_ROOT} (${names.join(", ")}): pass the one you want`);
    }
    return path.join(OUTPUT_ROOT, names[0]);
}
