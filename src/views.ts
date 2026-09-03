import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readStreamTarget, StreamTarget } from "./credentials";

const VIEW_DIRECTORY = path.join(os.homedir(), "Desktop");
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
    const entries = await fs.promises.readdir(VIEW_DIRECTORY);
    const names = entries.filter(entry => VIEW_PATTERN.test(entry)).sort();
    const views: View[] = [];
    for (const name of names) {
        const file = path.join(VIEW_DIRECTORY, name);
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
