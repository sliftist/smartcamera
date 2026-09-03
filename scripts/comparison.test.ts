import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ComparisonRun, nextSizeDown, listRuns, readRun } from "../src/comparison";

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

console.log(`picking the size below:`);
check("below the default", nextSizeDown({ width: 1280, height: 704 }), { width: 896, height: 504, frameMs: 447 });
check("below the largest", nextSizeDown({ width: 1920, height: 1080 }), { width: 1280, height: 704, frameMs: 996 });
check("nothing below the smallest", nextSizeDown({ width: 640, height: 360 }), undefined);
// An odd size is not one of the presets, so it takes the largest that is genuinely smaller.
check("below an off-preset size", nextSizeDown({ width: 1000, height: 600 }), { width: 896, height: 504, frameMs: 447 });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "comparison-"));
const run = new ComparisonRun(root, { width: 1280, height: 704 }, { width: 896, height: 504 });
const at = Date.now();

console.log(`\nonly disagreements are written:`);
// Both sizes agree, which is the common case and the one that must cost nothing.
run.record(at, ["person", "typing"], ["typing", "person"], undefined);
check("agreeing in a different order is still agreeing", run.deviations, 0);
run.record(at + 1000, [], [], undefined);
check("both empty agrees too", run.deviations, 0);

// The smaller size misses something the larger saw.
run.record(at + 2000, ["person", "drinking"], ["person"], Buffer.from("not really a jpeg").toString("base64"));
// And sees something the larger did not.
run.record(at + 3000, ["person"], ["person", "door open"], undefined);
check("two disagreements recorded", run.deviations, 2);
check("four rounds compared", run.rounds, 4);
run.close();

console.log(`\nreading it back:`);
const runs = listRuns(root);
check("the run is listed", runs.length, 1);
const { summary, deviations } = readRun(root, runs[0]);
check("both deviations are there", deviations.length, 2);
check("rounds came from the run file", summary.rounds, 4);
check("what differed, first time", deviations[0].differ, ["drinking"]);
check("and the frame was kept", typeof deviations[0].frame, "string");
check("no frame when none was sent", deviations[1].frame, undefined);

// Which way it went is the useful part: a question the smaller size keeps missing is a reason not to
// use it, and one it keeps inventing is a different problem.
const drinking = summary.byQuestion.find(row => row.question === "drinking");
const door = summary.byQuestion.find(row => row.question === "door open");
check("missed by the smaller", { differed: drinking?.differed, missed: drinking?.missedByLower, extra: drinking?.extraInLower },
    { differed: 1, missed: 1, extra: 0 });
check("seen only by the smaller", { differed: door?.differed, missed: door?.missedByLower, extra: door?.extraInLower },
    { differed: 1, missed: 0, extra: 1 });

fs.rmSync(root, { recursive: true, force: true });
console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
