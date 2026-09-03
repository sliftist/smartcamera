import * as fs from "fs";
import * as path from "path";
import { canonicalPhrase } from "./questions";

/**
 * Reading the day files back, and working out how much of the time each thing was true.
 *
 * The files hold changes, not states, so everything here is a replay: carry a running set forward
 * and apply each line to it. A line with a state replaces the set outright, which is what the first
 * line of a day and every heartbeat are; a line with added or removed amends it.
 *
 * The hard part is the denominator. "True 20% of the time" is meaningless without knowing what time
 * it is 20% of, and the log has holes in it: the service is not always running. A gap longer than a
 * heartbeat is downtime and is not counted as time at all, so a condition is measured against the
 * time it was actually being watched rather than against the wall clock.
 */

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/**
 * A gap longer than this is treated as the service being down rather than the scene being still.
 * Comfortably above the one minute heartbeat, so an ordinary late write is not read as an outage.
 */
export const MAX_TRACKED_GAP_MS = 150_000;

export type HistoryEvent = {
    at: number;
    /** Present on a snapshot line, which replaces the whole set. */
    state?: string[];
    added?: string[];
    removed?: string[];
};

export type ConditionStats = {
    condition: string;
    /** How long it was true, over the time anything was being watched at all. */
    trueMs: number;
    fraction: number;
    /**
     * How many separate times it happened, not how many rounds it was true for. Sitting at the desk
     * for an hour is one instance, not two thousand.
     */
    instances: number;
};

export type HistorySummary = {
    trackedMs: number;
    /** Wall clock covered by the files read, including the parts nothing was running. */
    spanMs: number;
    from: number;
    to: number;
    days: string[];
    conditions: ConditionStats[];
};

export function dayFiles(directory: string): string[] {
    try {
        return fs.readdirSync(directory).filter(name => DAY_FILE.test(name)).sort();
    } catch {
        return [];
    }
}

/** Every line of the last so many day files, oldest first. */
export function readHistory(directory: string, days: number): { events: HistoryEvent[]; days: string[] } {
    const names = dayFiles(directory).slice(-Math.max(1, days));
    const events: HistoryEvent[] = [];
    for (const name of names) {
        const contents = fs.readFileSync(path.join(directory, name), "utf8");
        for (const line of contents.split("\n")) {
            if (!line.trim()) {
                continue;
            }
            try {
                const parsed = JSON.parse(line) as HistoryEvent;
                if (typeof parsed.at === "number") {
                    // A week of files straddles the day the word moved into the phrase, so the same
                    // condition is written two ways. Read as one, or every stat covering that day
                    // would be split down the middle by a change that was only ever cosmetic.
                    events.push({
                        at: parsed.at,
                        state: parsed.state?.map(canonicalPhrase),
                        added: parsed.added?.map(canonicalPhrase),
                        removed: parsed.removed?.map(canonicalPhrase),
                    });
                }
            } catch {
                // A half written last line after a hard stop. Skipped rather than complained about.
            }
        }
    }
    return { events, days: names };
}

export function summarise(events: HistoryEvent[], days: string[]): HistorySummary {
    const trueMs = new Map<string, number>();
    const instances = new Map<string, number>();
    let trackedMs = 0;
    let held = new Set<string>();
    let previousAt = 0;

    for (const event of events) {
        if (previousAt > 0) {
            const gap = event.at - previousAt;
            // A long gap is the service having been away, and time nobody was watching is not time
            // this can say anything about. Counting it would quietly credit whatever was true when
            // it stopped with every hour it was off.
            if (gap > 0 && gap <= MAX_TRACKED_GAP_MS) {
                trackedMs += gap;
                for (const condition of held) {
                    trueMs.set(condition, (trueMs.get(condition) ?? 0) + gap);
                }
            }
        }
        const next = event.state
            ? new Set(event.state)
            : new Set([...held].filter(item => !(event.removed ?? []).includes(item)).concat(event.added ?? []));
        // Counted where it turns on, so an hour at the desk is one instance rather than two thousand.
        // Coming back after downtime counts as a new one, which is what it looks like from here.
        for (const condition of next) {
            if (!held.has(condition)) {
                instances.set(condition, (instances.get(condition) ?? 0) + 1);
            }
        }
        held = next;
        previousAt = event.at;
    }

    const names = new Set([...trueMs.keys(), ...instances.keys()]);
    const conditions = [...names]
        .map(condition => ({
            condition,
            trueMs: trueMs.get(condition) ?? 0,
            fraction: trackedMs > 0 ? (trueMs.get(condition) ?? 0) / trackedMs : 0,
            instances: instances.get(condition) ?? 0,
        }))
        .sort((left, right) => right.trueMs - left.trueMs);

    const from = events.length > 0 ? events[0].at : 0;
    const to = events.length > 0 ? events[events.length - 1].at : 0;
    return { trackedMs, spanMs: Math.max(0, to - from), from, to, days, conditions };
}
