import * as fs from "fs";
import * as path from "path";

/**
 * Where downloaded door clips live, and what keeps them from filling the disk.
 *
 * One folder per local day, one mp4 per clip, named by the clip's peak time. That name is the whole
 * bookkeeping system: it says which clip a file is, so knowing what has already been fetched is a
 * directory listing rather than a database, and a file that half wrote and was interrupted is
 * replaced rather than skipped.
 *
 * The size is tracked in memory and updated as files come and go. It is measured once, by walking
 * the folders at startup, and never again: re-adding up every file on each write would turn a
 * download into a full directory scan, and there are tens of thousands of files. Nothing is
 * persisted, so there is no cached total that can quietly disagree with the disk. The walk is the
 * only truth and it happens once.
 */

export type StoredClip = {
    /** The clip's peak time, which is its identity on the camera and in the file name. */
    t: number;
    /** Local day folder, "YYYY-MM-DD". */
    day: string;
    file: string;
    bytes: number;
};

function pad2(value: number): string {
    return String(value).padStart(2, "0");
}

export function dayFolder(ms: number): string {
    const at = new Date(ms);
    return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
}

/** Sorts and reads back as a time, so a listing is chronological and a name says when. */
export function clipName(startMs: number, t: number): string {
    const at = new Date(startMs);
    return `${pad2(at.getHours())}-${pad2(at.getMinutes())}-${pad2(at.getSeconds())}_${t}.mp4`;
}

const CLIP_NAME = /_(\d+)\.mp4$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

export class ClipStore {
    /** By clip time, so "do we have this one" is a lookup rather than a search. */
    private clips = new Map<number, StoredClip>();
    private totalBytes = 0;

    constructor(private root: string, private budgetBytes: number) {
        fs.mkdirSync(root, { recursive: true });
        this.scan();
    }

    /**
     * The one full walk, at startup.
     *
     * Deliberately not a saved index. A saved one would have to survive being killed mid write and
     * would drift from the disk the first time it did not, and the recovery for that is this walk
     * anyway. Doing it once at startup costs a second and cannot be wrong.
     */
    private scan() {
        for (const day of fs.readdirSync(this.root)) {
            if (!DAY_FOLDER.test(day)) {
                continue;
            }
            for (const file of fs.readdirSync(path.join(this.root, day))) {
                const match = CLIP_NAME.exec(file);
                if (!match) {
                    continue;
                }
                let bytes: number;
                try {
                    bytes = fs.statSync(path.join(this.root, day, file)).size;
                } catch {
                    continue;
                }
                const t = Number(match[1]);
                this.clips.set(t, { t, day, file, bytes });
                this.totalBytes += bytes;
            }
        }
    }

    has(t: number): boolean {
        return this.clips.has(t);
    }

    get count(): number {
        return this.clips.size;
    }

    get bytes(): number {
        return this.totalBytes;
    }

    get full(): boolean {
        return this.totalBytes >= this.budgetBytes;
    }

    /** The oldest clip held, which is what a prune would take next. */
    oldest(): StoredClip | undefined {
        let best: StoredClip | undefined;
        for (const clip of this.clips.values()) {
            if (!best || clip.t < best.t) {
                best = clip;
            }
        }
        return best;
    }

    /** Written whole under a temporary name first, so an interrupted write is never mistaken for a clip. */
    write(t: number, startMs: number, mp4: Buffer): StoredClip {
        const day = dayFolder(startMs);
        const file = clipName(startMs, t);
        const folder = path.join(this.root, day);
        fs.mkdirSync(folder, { recursive: true });
        const target = path.join(folder, file);
        const temporary = `${target}.part`;
        fs.writeFileSync(temporary, mp4);
        fs.renameSync(temporary, target);

        const existing = this.clips.get(t);
        if (existing) {
            this.totalBytes -= existing.bytes;
        }
        const clip: StoredClip = { t, day, file, bytes: mp4.length };
        this.clips.set(t, clip);
        this.totalBytes += mp4.length;
        return clip;
    }

    private remove(clip: StoredClip) {
        try {
            fs.unlinkSync(path.join(this.root, clip.day, clip.file));
        } catch {
            // Already gone, which is the state we wanted. The accounting still has to be corrected.
        }
        this.clips.delete(clip.t);
        this.totalBytes -= clip.bytes;
        try {
            // Empty because its last clip just went. Left behind it would only be noise in a listing.
            fs.rmdirSync(path.join(this.root, clip.day));
        } catch {
            // Not empty, which is the normal case.
        }
    }

    /**
     * A clip somebody has labelled by hand, which must not be deleted.
     *
     * Checked against the disk rather than remembered, because the labelling runs in another process
     * and anything held here would be as old as the last restart. It is a single stat, and only on a
     * clip about to be deleted, so the cost lands where it can be afforded.
     */
    private labelled(clip: StoredClip): boolean {
        const sidecar = path.join(this.root, clip.day, `${clip.file.replace(/\.mp4$/, "")}.json`);
        try {
            fs.accessSync(sidecar);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Deletes oldest first until back under budget, keeping anything labelled.
     *
     * A label is the only thing here that cannot be recreated: the footage can always be fetched
     * again while the camera still holds it, but somebody sat and watched that clip. Losing one to a
     * routine cleanup would be the worst thing this could do, so a labelled clip stays even if that
     * means sitting over budget.
     *
     * Sorted per call rather than kept sorted. A prune happens at most once per download and only
     * when full, where a walk of the list is nothing next to keeping an ordered structure correct
     * through every insert and delete.
     */
    prune(): { removed: number; bytes: number; kept: number } {
        if (this.totalBytes <= this.budgetBytes) {
            return { removed: 0, bytes: 0, kept: 0 };
        }
        const order = [...this.clips.values()].sort((left, right) => left.t - right.t);
        let removed = 0;
        let bytes = 0;
        let kept = 0;
        for (const clip of order) {
            if (this.totalBytes <= this.budgetBytes) {
                break;
            }
            if (this.labelled(clip)) {
                kept++;
                continue;
            }
            bytes += clip.bytes;
            removed++;
            this.remove(clip);
        }
        return { removed, bytes, kept };
    }
}
