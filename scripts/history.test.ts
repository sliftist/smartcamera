import { summarise, MAX_TRACKED_GAP_MS, HistoryEvent } from "../src/history";

let failures = 0;

function check(label: string, got: unknown, want: unknown) {
    const same = JSON.stringify(got) === JSON.stringify(want);
    if (!same) {
        failures++;
    }
    console.log(`  ${same ? "ok  " : "FAIL"} ${label}`);
    if (!same) {
        console.log(`         got  ${JSON.stringify(got)}`);
        console.log(`         want ${JSON.stringify(want)}`);
    }
}

const MINUTE = 60_000;
const start = 1_700_000_000_000;
const of = (summary: ReturnType<typeof summarise>, condition: string) =>
    summary.conditions.find(item => item.condition === condition);

console.log(`time true, against the time anything was watched:`);
{
    // Ten minutes with a person there for the first four. Written the way the recorder writes it: a
    // line at least once a minute, so nothing here looks like a gap.
    const events: HistoryEvent[] = [{ at: start, state: ["person"] }];
    for (let minute = 1; minute <= 10; minute++) {
        events.push(minute === 4
            ? { at: start + minute * MINUTE, removed: ["person"] }
            : { at: start + minute * MINUTE, state: minute < 4 ? ["person"] : [] });
    }
    const summary = summarise(events, ["a.jsonl"]);
    check("tracked the whole span", summary.trackedMs, 10 * MINUTE);
    check("true for four of ten", of(summary, "person")?.trueMs, 4 * MINUTE);
    check("which is 40%", Math.round((of(summary, "person")?.fraction ?? 0) * 100), 40);
}

// The reason the heartbeat exists. Without excluding the gap, whatever was true when the service
// stopped would be credited with every hour it was off, and the percentage would be a fiction.
console.log(`\na gap is downtime, not stillness:`);
{
    const events: HistoryEvent[] = [
        { at: start, state: ["person"] },
        { at: start + MINUTE, state: ["person"] },
        // Six hours where nothing was running at all.
        { at: start + MINUTE + 6 * 3600_000, state: ["person"] },
        { at: start + 2 * MINUTE + 6 * 3600_000, state: [] },
    ];
    const summary = summarise(events, ["a.jsonl"]);
    check("the outage is not counted as time", summary.trackedMs, 2 * MINUTE);
    check("nor credited to what was true", of(summary, "person")?.trueMs, 2 * MINUTE);
    check("but the wall clock span still says it happened",
        summary.spanMs, 2 * MINUTE + 6 * 3600_000);
    check("a gap just under the limit is still counted",
        summarise([{ at: start, state: [] }, { at: start + MAX_TRACKED_GAP_MS - 1, state: [] }], []).trackedMs,
        MAX_TRACKED_GAP_MS - 1);
    check("and just over it is not",
        summarise([{ at: start, state: [] }, { at: start + MAX_TRACKED_GAP_MS + 1, state: [] }], []).trackedMs, 0);
}

// Occurrences, not rounds. Sitting at the desk for an hour is one instance.
console.log(`\ninstances are occurrences, not ticks:`);
{
    const events: HistoryEvent[] = [
        { at: start, state: [] },
        { at: start + MINUTE, added: ["typing"] },
        // Still typing a minute later, reported again by a heartbeat: the same instance.
        { at: start + 2 * MINUTE, state: ["typing"] },
        { at: start + 3 * MINUTE, removed: ["typing"] },
        { at: start + 4 * MINUTE, added: ["typing"] },
        { at: start + 5 * MINUTE, removed: ["typing"] },
    ];
    const summary = summarise(events, ["a.jsonl"]);
    check("two separate stretches", of(summary, "typing")?.instances, 2);
    // On at +1, off at +3, on at +4, off at +5: two minutes then one, so three.
    check("three minutes in total", of(summary, "typing")?.trueMs, 3 * MINUTE);
    check("a heartbeat during one does not start another",
        summarise([
            { at: start, state: ["typing"] },
            { at: start + MINUTE, state: ["typing"] },
            { at: start + 2 * MINUTE, state: ["typing"] },
        ], []).conditions[0].instances, 1);
}

console.log(`\nnothing to report:`);
check("no events at all", summarise([], []).conditions, []);
check("and no divide by zero", summarise([{ at: start, state: ["x"] }], []).conditions[0].fraction, 0);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
