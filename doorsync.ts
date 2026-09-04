import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { DoorClient, Section, Gop, readDoorPassword, DOOR_HOST } from "./src/doorClient";
import { muxClip } from "./src/doorMux";
import { ClipStore } from "./src/clipStore";

/**
 * Keeps a local copy of the door camera's activity clips, as mp4s.
 *
 * The camera writes a clip only once it has ended, and never rewrites one, so a clip is permanent
 * the moment it appears. That makes this a one way sync with no reconciliation: anything already on
 * disk is correct forever, and the only question each pass is what is new.
 *
 * It backfills history oldest first while there is room and then watches for new clips, and it holds
 * itself to spending at least a third of its time idle. The camera is a pi encoding video in
 * hardware on every frame and has nothing spare; taking clips as fast as it will serve them would
 * come straight out of the recording it is there to do.
 */

/** Only clips with at least this much movement at their peak. Below it is mostly light and weather. */
const ACTIVITY_THRESHOLD = 0.03;
const CLIP_ROOT = path.join(__dirname, "doorclips");
const BUDGET_BYTES = 50 * 1024 * 1024 * 1024;
/**
 * Idle time after each request, as a fraction of how long that request took.
 *
 * Paced off the camera's own speed rather than a fixed delay, so it backs off exactly when the
 * camera is struggling and does not dawdle when it is not. A request that took two seconds is
 * followed by a second of nothing.
 */
const IDLE_RATIO = 0.5;
/** How often to look for clips that have appeared since the last look. */
const WATCH_INTERVAL_MS = 20 * 1000;
/**
 * How far back a watch pass asks, beyond what it has already seen.
 *
 * Not just "since the last clip". The camera files a clip under the day it started, and its lookup
 * walks forward from the start of the day the query begins in, so a clip that ran across midnight
 * lives in a file that a query starting after midnight never opens. Reaching back a few hours means
 * the query begins in the previous day and finds it. Costs one extra small file read.
 */
const WATCH_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const RECONNECT_MS = 15 * 1000;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

function sizeOf(bytes: number): string {
    if (bytes >= 1024 ** 3) {
        return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
    }
    if (bytes >= 1024 ** 2) {
        return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
    }
    return `${Math.round(bytes / 1024)}KB`;
}

/**
 * Runs one request and then rests in proportion to how long it took.
 *
 * Wrapping the request rather than sleeping between clips is deliberate: a clip is many requests,
 * and pacing only between clips would let a long one hammer the camera the whole way through.
 */
async function paced<T>(run: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    try {
        return await run();
    } finally {
        const idleMs = Math.round((Date.now() - startedAtMs) * IDLE_RATIO);
        if (idleMs > 0) {
            await new Promise(resolve => setTimeout(resolve, idleMs));
        }
    }
}

function hoursSpanned(fromMs: number, toMs: number): { day: string[]; hour: string }[] {
    const out: { day: string[]; hour: string }[] = [];
    const start = new Date(fromMs);
    start.setMinutes(0, 0, 0);
    for (let at = start.getTime(); at <= toMs; at += 3600_000) {
        const when = new Date(at);
        out.push({
            day: [
                String(when.getFullYear()),
                String(when.getMonth() + 1).padStart(2, "0"),
                String(when.getDate()).padStart(2, "0"),
            ],
            hour: String(when.getHours()).padStart(2, "0"),
        });
    }
    return out;
}

class Sync {
    private client: DoorClient | undefined;
    /** Clips the camera offers that this will never take, so they are not reconsidered every pass. */
    private skipped = new Set<number>();
    private downloaded = 0;
    private failed = 0;

    constructor(private store: ClipStore, private password: string) {}

    private async connected(): Promise<DoorClient> {
        if (this.client) {
            return this.client;
        }
        const client = new DoorClient(this.password);
        await client.connect();
        this.client = client;
        log(`connected to the camera at ${DOOR_HOST}`);
        return client;
    }

    private drop(error: Error) {
        this.client?.close();
        this.client = undefined;
        log(`lost the camera: ${error.message}`);
    }

    /**
     * Fetches and writes one clip.
     *
     * The index for an hour is refetched per clip rather than cached. The current hour is still being
     * appended to, so a cache would go stale exactly where it matters, and a hit costs one small
     * request against a saving that only appears when many clips share an hour.
     */
    private async fetchClip(section: Section): Promise<boolean> {
        const client = await this.connected();
        const pieces: { gop: Gop; bytes: Buffer }[] = [];
        for (const { day, hour } of hoursSpanned(section.s, section.e)) {
            let index: { gops: Gop[] };
            try {
                index = await paced(() => client.hourIndex(day, hour));
            } catch (error) {
                if (/no such file|ENOENT/i.test((error as Error).message)) {
                    continue;
                }
                throw error;
            }
            // Overlapping the clip, and holding actual video. A run with no length is a still stretch
            // the camera recorded as a reference rather than as frames.
            const wanted = (index.gops || []).filter(gop =>
                gop.e >= section.s && gop.t <= section.e && gop.l > 0);
            for (const gop of wanted) {
                const bytes = await paced(() => client.gopData(day, gop.f, gop.o, gop.l));
                pieces.push({ gop, bytes: Buffer.from(bytes) });
            }
        }
        if (pieces.length === 0) {
            // The clip's window holds no encoded video. Recorded as skipped so it is not retried on
            // every pass forever.
            this.skipped.add(section.t);
            return false;
        }
        pieces.sort((left, right) => left.gop.t - right.gop.t);
        const clip = muxClip(pieces);
        const written = this.store.write(section.t, section.s, clip.mp4);
        log(`${written.day}/${written.file}  ${clip.frames} frames, ${(clip.durationMs / 1000).toFixed(1)}s,`
            + ` ${sizeOf(clip.mp4.length)}, activity ${section.a.toFixed(3)}`);
        return true;
    }

    /**
     * Takes a clip unless there is no room for it.
     *
     * A full store must not be filled with history. Backfill runs oldest first, so once full every
     * further old clip would be downloaded and then immediately deleted by the prune to make room
     * for itself, forever. Anything older than what is already held is therefore refused outright,
     * which stops the backfill on its own without needing to know it was a backfill.
     */
    private roomFor(section: Section): boolean {
        if (!this.store.full) {
            return true;
        }
        const oldest = this.store.oldest();
        return !oldest || section.t > oldest.t;
    }

    /**
     * Takes everything worth taking from a list of clips.
     *
     * A clip that fails costs that clip and nothing else. The camera stalls occasionally, and letting
     * one stall abort the run would send the backfill back to the first day to work out where it had
     * got to. Tried twice, since a stall is usually transient and the retry lands on a fresh
     * connection, then given up on for this run.
     */
    async take(sections: Section[]): Promise<number> {
        let taken = 0;
        for (const section of sections) {
            if (section.a < ACTIVITY_THRESHOLD || this.store.has(section.t) || this.skipped.has(section.t)) {
                continue;
            }
            if (!this.roomFor(section)) {
                this.skipped.add(section.t);
                continue;
            }
            for (let attempt = 1; attempt <= 2; attempt++) {
                try {
                    if (await this.fetchClip(section)) {
                        taken++;
                        this.downloaded++;
                    }
                    break;
                } catch (error) {
                    this.drop(error as Error);
                    if (attempt === 2) {
                        this.failed++;
                        log(`giving up on the clip at ${formatDateTime(section.s)} for now`);
                    }
                }
            }
            const pruned = this.store.prune();
            if (pruned.removed > 0 || pruned.kept > 0) {
                log(`over budget, deleted ${pruned.removed} of the oldest clips, freeing ${sizeOf(pruned.bytes)}`
                    + `${pruned.kept > 0 ? `, kept ${pruned.kept} that are labelled` : ""}`);
            }
        }
        return taken;
    }

    async sectionsFor(fromMs: number, toMs: number): Promise<Section[]> {
        const client = await this.connected();
        return paced(() => client.sections(fromMs, toMs));
    }

    async days(): Promise<string[]> {
        const client = await this.connected();
        return paced(() => client.availableDays());
    }

    get stats() {
        return { downloaded: this.downloaded, failed: this.failed, skipped: this.skipped.size };
    }
}

async function backfill(sync: Sync, store: ClipStore, limitDays: number | undefined) {
    // Oldest first, so the store fills forward in time and the refusal in roomFor stops it exactly
    // when there is no more room, rather than part way through a day.
    let days = (await sync.days()).sort();
    if (limitDays) {
        days = days.slice(-limitDays);
    }
    log(`backfilling ${days.length} day${days.length === 1 ? "" : "s"}, from ${days[0]} to ${days[days.length - 1]}`);
    for (const day of days) {
        const [year, month, date] = day.split("/").map(Number);
        const from = new Date(year, month - 1, date).getTime();
        const to = new Date(year, month - 1, date + 1).getTime() - 1;
        const sections = await sync.sectionsFor(from, to);
        const worth = sections.filter(section => section.a >= ACTIVITY_THRESHOLD);
        const taken = await sync.take(sections);
        log(`${day}: ${sections.length} clips, ${worth.length} above the threshold, took ${taken}`
            + ` | holding ${store.count} clips, ${sizeOf(store.bytes)}`);
    }
}

async function watch(sync: Sync, store: ClipStore) {
    log(`watching for new clips every ${WATCH_INTERVAL_MS / 1000}s`);
    let seenTo = Date.now() - WATCH_LOOKBACK_MS;
    while (true) {
        try {
            const now = Date.now();
            const from = Math.min(seenTo, now - WATCH_LOOKBACK_MS);
            const sections = await sync.sectionsFor(from, now);
            const taken = await sync.take(sections);
            if (taken > 0) {
                log(`took ${taken} new clip${taken === 1 ? "" : "s"} | holding ${store.count}, ${sizeOf(store.bytes)}`);
            }
            seenTo = now;
        } catch (error) {
            log(`pass failed, retrying in ${RECONNECT_MS / 1000}s: ${(error as Error).message}`);
            await new Promise(resolve => setTimeout(resolve, RECONNECT_MS));
            continue;
        }
        await new Promise(resolve => setTimeout(resolve, WATCH_INTERVAL_MS));
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const dayFlag = argv.indexOf("--days");
    // Bounded to the most recent days, for trying it against real footage without pulling everything.
    const limitDays = dayFlag >= 0 ? Number(argv[dayFlag + 1]) : undefined;
    const once = argv.includes("--once");

    const password = await readDoorPassword(log);
    const store = new ClipStore(CLIP_ROOT, BUDGET_BYTES);
    log(`clips in ${CLIP_ROOT}, holding ${store.count}, ${sizeOf(store.bytes)} of ${sizeOf(BUDGET_BYTES)}`);
    const sync = new Sync(store, password);

    while (true) {
        try {
            await backfill(sync, store, limitDays);
            break;
        } catch (error) {
            log(`backfill interrupted, retrying in ${RECONNECT_MS / 1000}s: ${(error as Error).message}`);
            await new Promise(resolve => setTimeout(resolve, RECONNECT_MS));
        }
    }
    const done = sync.stats;
    log(`backfill done: ${done.downloaded} downloaded, ${done.failed} failed, ${done.skipped} passed over`
        + ` | holding ${store.count} clips, ${sizeOf(store.bytes)}`);
    if (once) {
        return;
    }
    await watch(sync, store);
}

main().catch(error => {
    console.error(`[doorsync] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});

