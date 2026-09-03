import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readStreamTarget, StreamTarget } from "./credentials";

/** Desktop is where they sit on Windows, and the home folder itself is where they sit on Linux. */
const VIEW_DIRECTORIES = [path.join(os.homedir(), "Desktop"), os.homedir()];
const VIEW_PATTERN = /^view\d*\.bat$/i;
/** The only view mounted the wrong way up, matching what "yarn eye" passes. */
const UPSIDE_DOWN_VIEWS = new Set(["view2.bat"]);

export type View = {
    index: number;
    name: string;
    file: string;
    target: StreamTarget;
    upsideDown: boolean;
};

/**
 * Sorted so an index always means the same camera. An index is the only thing a caller gets to pick,
 * which is why it is a position in this list and never a path.
 */
export async function loadViews(): Promise<View[]> {
    // The first directory holding any view wins, so a stray file in home cannot shadow a Desktop set.
    let directory = VIEW_DIRECTORIES[0];
    let names: string[] = [];
    for (const candidate of VIEW_DIRECTORIES) {
        const entries = await fs.promises.readdir(candidate).catch(() => [] as string[]);
        const found = entries.filter(entry => VIEW_PATTERN.test(entry)).sort();
        if (found.length > 0) {
            directory = candidate;
            names = found;
            break;
        }
    }
    const views: View[] = [];
    for (const name of names) {
        const file = path.join(directory, name);
        views.push({
            index: views.length,
            name,
            file,
            target: await readStreamTarget(file),
            upsideDown: UPSIDE_DOWN_VIEWS.has(name.toLowerCase()),
        });
    }
    return views;
}
