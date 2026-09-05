import * as fs from "fs";
import * as path from "path";
import { decode as decodeJpeg } from "jpeg-js";
import { LlamaAskClient } from "../src/askLlama";
import { RgbImage } from "../src/yolo";
import { SELECTORS } from "./frameSelect";
import { statsPath } from "./frameStats";

/**
 * Can the model find the deliveries that were labelled by hand?
 *
 * Every clip is a set of frames, one a second, already on disk. Each frame is asked one question and
 * a clip counts as a delivery if any single frame says so. That rule is the point rather than a
 * convenience: a delivery is a moment inside a clip, and most frames of a clip containing one show
 * an empty hallway before or after it. Requiring agreement across frames would throw away every
 * delivery that is only briefly visible.
 *
 * A miss costs far more than a false alarm here. Thirty of four hundred and seventy four clips are
 * deliveries, so guessing no is right ninety four percent of the time and completely useless, which
 * is why accuracy is not reported at all. Recall is the number that matters and precision is only
 * worth watching so a prompt cannot win by saying yes to everything.
 */

const CLIP_ROOT = path.join(__dirname, "..", "doorclips");
const FRAME_ROOT = path.join(__dirname, "..", "doorframes");
const RESULT_ROOT = path.join(__dirname, "..", "state", "eval");
const CLIP_NAME = /_(\d+)\.mp4$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;
/** One word back. Anything longer is the model explaining itself, which costs time and says no more. */
const MAX_NEW_TOKENS = 4;

/**
 * The prompts being compared.
 *
 * Kept as a list so a run names one and two runs are comparable. They differ in what they ask about:
 * the event, the object, or the person, since it is not obvious which of those a model finds easiest
 * to see in a fisheye hallway shot.
 */
const PROMPTS: Record<string, string> = {
    event: `Is a package being delivered in this image?\nAnswer with one word, yes or no.`,

    object: `Look at this hallway. Is there a cardboard box, package, parcel, padded envelope, or a`
        + ` delivery bag anywhere in this image, either sitting on the floor or being carried?\n`
        + `Answer with one word, yes or no.`,

    either: `Answer yes if either of these is true of this image:\n`
        + `- there is a box, package, parcel, envelope or delivery bag on the floor or against a door\n`
        + `- a person is carrying or holding a box, package, parcel or bag\n`
        + `Otherwise answer no.\n`
        + `Answer with one word, yes or no.`,

    generous: `This is a hallway outside some apartment doors, from a camera above a door.\n`
        + `Answer yes if you can see anything that might be a delivered item or something being`
        + ` delivered: a box, a parcel, a package, an envelope, a bag, a sack, or a person carrying`
        + ` or setting down any of those. If you are unsure, answer yes.\n`
        + `Otherwise answer no.\n`
        + `Answer with one word, yes or no.`,

    /**
     * Asks about the courier as well as the package.
     *
     * Both clips the object-only prompt missed were couriers in high visibility vests with nothing
     * in shot: one holding a phone to scan, one crouched at the door with the package already below
     * the camera's view. The package is the last thing to be visible and often never is, so looking
     * only for it misses the deliveries where it was set down out of frame. The person doing it is
     * in shot for the whole clip.
     */
    courier: `This is a hallway outside apartment doors, seen from a camera above one of them.\n`
        + `Answer yes if any of these is true of this image:\n`
        + `- there is a box, package, parcel, envelope or bag on the floor or against a door\n`
        + `- a person is carrying or holding a box, package, parcel or bag\n`
        + `- a person is wearing a high visibility vest or a delivery uniform\n`
        + `- a person is crouching, bending down, or reaching towards the floor near a door\n`
        + `Otherwise answer no.\n`
        + `Answer with one word, yes or no.`,

    /**
     * The courier prompt plus the phone.
     *
     * The one clip courier still misses is somebody in a plain shirt and shorts, no vest and nothing
     * in shot, walking the hallway holding a phone up in front of him and leaving empty handed a few
     * seconds later. Checking the door number on a phone is what an app courier does and is the only
     * thing separating him from a resident, so it is the only clause that could catch him. It is also
     * the clause most likely to fire on somebody who simply lives here and is reading a message.
     */
    phone: `This is a hallway outside apartment doors, seen from a camera above one of them.\n`
        + `Answer yes if any of these is true of this image:\n`
        + `- there is a box, package, parcel, envelope or bag on the floor or against a door\n`
        + `- a person is carrying or holding a box, package, parcel or bag\n`
        + `- a person is wearing a high visibility vest or a delivery uniform\n`
        + `- a person is crouching, bending down, or reaching towards the floor near a door\n`
        + `- a person is holding up a phone and looking at it while walking\n`
        + `Otherwise answer no.\n`
        + `Answer with one word, yes or no.`,

    /**
     * The same net, with the thing that was catching residents taken out of it.
     *
     * Nearly every false alarm was somebody who lives here walking past with a backpack, a handbag or
     * a bag of shopping. Asking about a "bag" at all was the mistake: the word covers what a courier
     * carries and what everybody else carries, and there is no telling the two apart from the word.
     * So the bags are named specifically, personal ones are ruled out by name, and the loose clauses
     * are tightened to the shapes a delivery actually takes.
     */
    strict: `This is a hallway outside apartment doors, seen from a camera above one of them.\n`
        + `Answer yes if any of these is true of this image:\n`
        + `- a cardboard box, parcel, package or padded envelope is on the floor or against a door\n`
        + `- a person is carrying a cardboard box, parcel, package or padded envelope\n`
        + `- a person is carrying an insulated food delivery bag\n`
        + `- a person is wearing a high visibility vest or a delivery uniform\n`
        + `- a person is crouching or bending down to put something on the floor near a door\n`
        + `- a person is holding up a phone and reading it while walking down the hallway\n`
        + `Answer no if the only thing in the image is an empty hallway, or a person carrying nothing,`
        + ` or a person carrying a backpack, handbag, purse, shoulder bag, suitcase or shopping.\n`
        + `Answer with one word, yes or no.`,
};

/** Anything that is not clearly a no is treated as a yes, since a miss is the expensive mistake. */
function saidYes(answer: string): boolean {
    const word = answer.trim().toLowerCase().replace(/[^a-z]/g, "");
    return word.startsWith("y") || (!word.startsWith("n") && word.length > 0);
}

type Clip = { day: string; file: string; t: number; labels: string[]; frames: string[] };

function loadClips(): Clip[] {
    const out: Clip[] = [];
    for (const day of fs.readdirSync(CLIP_ROOT).filter(name => DAY_FOLDER.test(name)).sort()) {
        for (const file of fs.readdirSync(path.join(CLIP_ROOT, day)).filter(name => CLIP_NAME.test(name)).sort()) {
            const stem = file.replace(/\.mp4$/, "");
            let labels: string[] = [];
            try {
                labels = (JSON.parse(fs.readFileSync(path.join(CLIP_ROOT, day, `${stem}.json`), "utf8")) as { labels: string[] }).labels;
            } catch {
                // Never reviewed, so there is nothing to measure against. Left out below.
                continue;
            }
            let frames: string[] = [];
            try {
                frames = fs.readdirSync(path.join(FRAME_ROOT, day, stem)).filter(name => name.endsWith(".jpg")).sort();
            } catch {
                continue;
            }
            if (frames.length > 0) {
                out.push({ day, file, t: Number(CLIP_NAME.exec(file)![1]), labels, frames });
            }
        }
    }
    return out;
}

function readFrame(clip: Clip, name: string): RgbImage {
    const raw = decodeJpeg(fs.readFileSync(path.join(FRAME_ROOT, clip.day, clip.file.replace(/\.mp4$/, ""), name)), { useTArray: true });
    const rgb = Buffer.alloc(raw.width * raw.height * 3);
    for (let i = 0, at = 0; i < raw.width * raw.height; i++) {
        rgb[at++] = raw.data[i * 4];
        rgb[at++] = raw.data[i * 4 + 1];
        rgb[at++] = raw.data[i * 4 + 2];
    }
    return { width: raw.width, height: raw.height, rgb };
}

/**
 * The clips a run is measured on.
 *
 * Every delivery is always included, because there are only thirty and leaving any out would make
 * recall a guess. The negatives are sampled, evenly across the whole archive rather than at random,
 * so a smaller run still covers every time of day and every kind of quiet hallway rather than one
 * afternoon of it.
 */
function pick(clips: Clip[], negatives: number): Clip[] {
    const positive = clips.filter(clip => clip.labels.length > 0);
    const negative = clips.filter(clip => clip.labels.length === 0);
    if (negatives >= negative.length) {
        return [...positive, ...negative];
    }
    const step = negative.length / negatives;
    const sampled: Clip[] = [];
    for (let i = 0; i < negatives; i++) {
        sampled.push(negative[Math.floor(i * step)]);
    }
    return [...positive, ...sampled];
}

async function main() {
    const argv = process.argv.slice(2);
    const value = (flag: string, fallback: string) => {
        const at = argv.indexOf(flag);
        return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
    };
    const promptName = value("--prompt", "either");
    const prompt = PROMPTS[promptName];
    if (!prompt) {
        throw new Error(`No prompt called ${promptName}. Have: ${Object.keys(PROMPTS).join(", ")}`);
    }
    const negatives = Number(value("--negatives", "40"));
    const width = Number(value("--width", "896"));
    const height = Number(value("--height", "504"));
    // A clip is a delivery the moment one frame says so, so the rest of its frames say nothing new.
    // Only skipping is honest here: it changes what a positive costs, never whether it is found.
    const stopEarly = !argv.includes("--all-frames");
    // Ask about a chosen few frames rather than all of them. The choice is made from the cheap grey
    // thumbnails, without the model, so the saving is real: the frames never asked about cost nothing.
    const selector = value("--select", "");

    let clips = pick(loadClips(), negatives);
    if (selector) {
        const choose = SELECTORS[selector];
        if (!choose) {
            throw new Error(`No selector called ${selector}. Have: ${Object.keys(SELECTORS).join(", ")}`);
        }
        clips = clips.map(clip => {
            const stem = clip.file.replace(/\.mp4$/, "");
            const stats = JSON.parse(fs.readFileSync(statsPath(clip.day, stem), "utf8")) as { grids: number[][] };
            const chosen = new Set(choose(stats.grids));
            return { ...clip, frames: clip.frames.filter((_, at) => chosen.has(at)) };
        });
    }
    const totalFrames = clips.reduce((sum, clip) => sum + clip.frames.length, 0);
    console.log(`prompt "${promptName}" at ${width}x${height}${selector ? `, frames chosen by "${selector}"` : ""}`);
    console.log(prompt.split("\n").map(line => `    ${line}`).join("\n"));
    console.log(`${clips.length} clips (${clips.filter(c => c.labels.length > 0).length} deliveries),`
        + ` up to ${totalFrames} frames\n`);

    const model = new LlamaAskClient(path.join(__dirname, ".."), message => console.log(`    [model] ${message}`));
    await model.start();

    const rows: { clip: Clip; found: boolean; atFrame: string | undefined; asked: number; hits: string[] }[] = [];
    let asked = 0;
    const startedAtMs = Date.now();
    for (const clip of clips) {
        let found = false;
        let atFrame: string | undefined;
        let count = 0;
        // Every frame that matched, not just the first. How many frames carry a delivery is what says
        // whether the answer is solid or hanging on a single lucky look, and only a full pass knows.
        const hits: string[] = [];
        for (const name of clip.frames) {
            count++;
            asked++;
            const result = await model.ask(readFrame(clip, name), prompt, MAX_NEW_TOKENS, { width, height });
            if (saidYes(result.answer)) {
                found = true;
                hits.push(name);
                atFrame = atFrame ?? name;
                if (stopEarly) {
                    break;
                }
            }
        }
        rows.push({ clip, found, atFrame, asked: count, hits });
        const truth = clip.labels.length > 0;
        if (truth !== found) {
            console.log(`  ${truth && !found ? "MISSED " : "false +"} ${clip.day} ${clip.file}`
                + `${atFrame ? ` at ${atFrame}` : ""}`);
        }
    }

    const elapsedMs = Date.now() - startedAtMs;
    const truePositive = rows.filter(row => row.clip.labels.length > 0 && row.found).length;
    const falseNegative = rows.filter(row => row.clip.labels.length > 0 && !row.found).length;
    const falsePositive = rows.filter(row => row.clip.labels.length === 0 && row.found).length;
    const trueNegative = rows.filter(row => row.clip.labels.length === 0 && !row.found).length;
    const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : 0;
    const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : 0;

    console.log(`\n  found ${truePositive} of ${truePositive + falseNegative} deliveries`);
    console.log(`  missed ${falseNegative}`);
    console.log(`  false alarms ${falsePositive} of ${falsePositive + trueNegative} quiet clips`);
    console.log(`  recall ${(recall * 100).toFixed(1)}%   precision ${(precision * 100).toFixed(1)}%`);
    console.log(`  ${asked} frames in ${(elapsedMs / 1000).toFixed(0)}s, ${Math.round(elapsedMs / Math.max(1, asked))}ms each`);

    fs.mkdirSync(RESULT_ROOT, { recursive: true });
    const target = path.join(RESULT_ROOT, `${promptName}-${width}x${height}${selector ? `-${selector}` : ""}.json`);
    fs.writeFileSync(target, JSON.stringify({
        prompt: promptName, text: prompt, width, height, negatives,
        recall, precision, truePositive, falseNegative, falsePositive, trueNegative,
        msPerFrame: Math.round(elapsedMs / Math.max(1, asked)),
        missed: rows.filter(row => row.clip.labels.length > 0 && !row.found).map(row => `${row.clip.day}/${row.clip.file}`),
        alarms: rows.filter(row => row.clip.labels.length === 0 && row.found).map(row => `${row.clip.day}/${row.clip.file} at ${row.atFrame}`),
        clips: rows.map(row => ({
            clip: `${row.clip.day}/${row.clip.file}`,
            delivery: row.clip.labels.length > 0,
            frames: row.clip.frames.length,
            asked: row.asked,
            hits: row.hits,
        })),
    }, null, 2));
    console.log(`  written to ${path.relative(process.cwd(), target)}`);

    if (!stopEarly) {
        // How thin the answer is. A clip resting on one frame would have been a coin toss, so this is
        // the number that says whether the one frame rule is comfortable or lucky.
        const found = rows.filter(row => row.clip.labels.length > 0 && row.found);
        const thin = found.slice().sort((left, right) => left.hits.length - right.hits.length);
        console.log(`\n  matching frames per delivery, fewest first:`);
        for (const row of thin.slice(0, 8)) {
            console.log(`    ${String(row.hits.length).padStart(3)} of ${String(row.clip.frames.length).padStart(3)}`
                + `   ${row.clip.day} ${row.clip.file}`);
        }
        console.log(`    deliveries resting on a single frame: ${found.filter(row => row.hits.length === 1).length}`);
    }

    model.stop();
    process.exit(0);
}

main().catch(error => {
    console.error(`[labelEval] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
