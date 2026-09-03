import * as fs from "fs";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";

const EYE2_URL = "http://127.0.0.1:8770";
const DEFAULT_INTERVAL_SECONDS = 3;
const DEFAULT_INDEX = 0;
/** eye2 writes the frame only once every answer about it is out, so it can lag the reply slightly. */
const FRAME_WAIT_MS = 2000;
const FRAME_POLL_MS = 100;
const OUTPUT_DIRECTORY = path.join(__dirname, "..", "hits");

type Answer = {
    prompt: string;
    answer: string;
    frameFile?: string;
    analyzeMs: number;
    error?: string;
};

/**
 * Yes or no is what a watch condition is, and a model asked for one still sometimes leads with a
 * clause. Anything that does not open with a yes is treated as a no, so a hedged answer never trips
 * the alarm on its own.
 */
function isAffirmative(answer: string): boolean {
    return /^\s*(yes|yeah|yep|correct|true)\b/i.test(answer);
}

function usage(): never {
    console.log(`Usage: yarn watch --until "<prompt that stops the watch>" [other prompts...]`);
    console.log(`         [--every <seconds>]   how often to ask, default ${DEFAULT_INTERVAL_SECONDS}`);
    console.log(`         [--index <n>]         which camera, default ${DEFAULT_INDEX}`);
    console.log(`         [--rounds <n>]        give up after this many rounds`);
    console.log(``);
    console.log(`Every prompt is asked each round. The watch stops the first time --until answers yes,`);
    console.log(`and the frame that answer was looking at is copied into ${OUTPUT_DIRECTORY}.`);
    process.exit(1);
}

async function ask(index: number, prompt: string): Promise<Answer> {
    try {
        const response = await fetch(EYE2_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ index: String(index), prompt }),
        });
        const reply = await response.json() as Record<string, unknown>;
        if (typeof reply.error === "string") {
            return { prompt, answer: "", analyzeMs: 0, error: reply.error };
        }
        return {
            prompt,
            answer: String(reply.answer ?? ""),
            frameFile: typeof reply.frameFile === "string" ? reply.frameFile : undefined,
            analyzeMs: Number(reply.analyzeMs ?? 0),
        };
    } catch (error) {
        return { prompt, answer: "", analyzeMs: 0, error: (error as Error).message };
    }
}

/** The jpeg is written after the answers go out, so it is worth waiting a moment for it to land. */
async function keepFrame(frameFile: string, label: string): Promise<string | undefined> {
    const deadline = Date.now() + FRAME_WAIT_MS;
    while (Date.now() < deadline) {
        if (fs.existsSync(frameFile) && fs.statSync(frameFile).size > 0) {
            fs.mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
            const kept = path.join(OUTPUT_DIRECTORY, `${label}.jpg`);
            fs.copyFileSync(frameFile, kept);
            return kept;
        }
        await new Promise(resolve => setTimeout(resolve, FRAME_POLL_MS));
    }
    return undefined;
}

async function main() {
    const args = process.argv.slice(2);
    let until = "";
    let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    let index = DEFAULT_INDEX;
    let maxRounds = Infinity;
    const prompts: string[] = [];
    for (let position = 0; position < args.length; position++) {
        const argument = args[position];
        if (argument === "--until") {
            until = args[++position] ?? "";
        } else if (argument === "--every") {
            intervalSeconds = Number(args[++position]);
        } else if (argument === "--index") {
            index = Number(args[++position]);
        } else if (argument === "--rounds") {
            maxRounds = Number(args[++position]);
        } else if (argument.startsWith("--")) {
            console.log(`Unknown option ${argument}`);
            usage();
        } else {
            prompts.push(argument);
        }
    }
    if (!until || !Number.isFinite(intervalSeconds) || intervalSeconds <= 0 || !Number.isFinite(index)) {
        usage();
    }

    // The stop condition is asked last, so the other questions describe the same frame that tripped it.
    const round = [...prompts, until];
    console.log(`[watch] camera ${index}, every ${intervalSeconds}s, ${round.length} question${round.length === 1 ? "" : "s"} a round`);
    console.log(`[watch] stopping when: ${JSON.stringify(until)}`);

    for (let number = 1; number <= maxRounds; number++) {
        const startedAtMs = Date.now();
        const answers: Answer[] = [];
        for (const prompt of round) {
            answers.push(await ask(index, prompt));
        }
        console.log(`\n${formatDateTime(Date.now())} | round ${number}`);
        for (const answer of answers) {
            console.log(`  ${JSON.stringify(answer.prompt)}`);
            console.log(`    -> ${answer.error ? `failed: ${answer.error}` : `${answer.answer || "(empty)"}  [${answer.analyzeMs.toFixed(0)}ms]`}`);
        }

        const trigger = answers[answers.length - 1];
        if (!trigger.error && isAffirmative(trigger.answer)) {
            console.log(`\n[watch] tripped on round ${number}: ${JSON.stringify(trigger.answer)}`);
            if (trigger.frameFile) {
                const kept = await keepFrame(trigger.frameFile, `hit-${Date.now()}`);
                console.log(kept ? `[watch] kept the frame at ${kept}` : `[watch] the frame at ${trigger.frameFile} never appeared`);
            } else {
                console.log(`[watch] no frame was kept; run eye2 with the "debug" flag to get one`);
            }
            return;
        }

        const remainingMs = intervalSeconds * 1000 - (Date.now() - startedAtMs);
        if (remainingMs > 0) {
            await new Promise(resolve => setTimeout(resolve, remainingMs));
        }
    }
    console.log(`\n[watch] gave up after ${maxRounds} rounds without a yes`);
}

main().catch(error => {
    console.error(`[watch] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
