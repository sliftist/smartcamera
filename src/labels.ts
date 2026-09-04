import * as fs from "fs";
import * as path from "path";

/**
 * What a clip was labelled as, kept in a small json file beside the clip itself.
 *
 * One file per clip rather than one index for everything. The labels are made by hand, once, and are
 * the only part of this that could not be recreated: a single index would have to be rewritten on
 * every keystroke and would take the whole set down with it if a write landed badly. A sidecar is
 * written once, is readable on its own, and can only ever lose the one clip it belongs to.
 *
 * It sits next to the video on purpose, so a day folder is a complete unit: move it, copy it or back
 * it up and the labels travel with the footage they describe.
 */

/**
 * The labels to choose from.
 *
 * Deliberately a short fixed list. This is for one pass over the archive by one person, so the value
 * is in every clip being judged against the same few questions, not in the vocabulary being rich.
 *
 * `implies` is what makes one label a subset of another: a delivery to a neighbor is still a
 * delivery, so choosing it selects the broader one too and clearing the broader one clears it. That
 * relationship lives here rather than in the page, since it is a fact about the labels themselves.
 */
export const LABELS: { key: string; name: string; implies?: string }[] = [
    { key: "delivery", name: "package delivery" },
    { key: "neighbor", name: "package delivery to neighbor", implies: "delivery" },
];

export const LABEL_KEYS = new Set(LABELS.map(label => label.key));

export type Label = {
    /** The clip's peak time, which is its identity everywhere else too. */
    t: number;
    labels: string[];
    /** When it was judged, so a later pass can tell old opinions from new ones. */
    at: number;
};

/** Beside the clip, same name, different extension. */
export function labelPath(root: string, day: string, file: string): string {
    return path.join(root, day, `${file.replace(/\.mp4$/, "")}.json`);
}

export function readLabel(root: string, day: string, file: string): Label | undefined {
    try {
        const parsed = JSON.parse(fs.readFileSync(labelPath(root, day, file), "utf8")) as Label;
        return Array.isArray(parsed.labels) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Applies the subset rule and writes.
 *
 * Enforced here rather than trusted from the page, because the page is not the only thing that could
 * ever write one of these and a stored label that contradicts the rule would be a quiet mess later.
 * An empty set removes the file, so "no labels" and "not judged yet" stay the same thing.
 */
export function writeLabel(root: string, day: string, file: string, wanted: string[]): Label | undefined {
    const chosen = new Set(wanted.filter(key => LABEL_KEYS.has(key)));
    for (const label of LABELS) {
        if (label.implies && chosen.has(label.key)) {
            chosen.add(label.implies);
        }
    }
    const target = labelPath(root, day, file);
    if (chosen.size === 0) {
        try {
            fs.unlinkSync(target);
        } catch {
            // Never judged, or already cleared. Either way it is now in the state asked for.
        }
        return undefined;
    }
    const match = /_(\d+)\.mp4$/.exec(file);
    const label: Label = {
        t: match ? Number(match[1]) : 0,
        // In the order they are offered, so two files are comparable without sorting.
        labels: LABELS.filter(item => chosen.has(item.key)).map(item => item.key),
        at: Date.now(),
    };
    fs.writeFileSync(target, `${JSON.stringify(label)}\n`);
    return label;
}
