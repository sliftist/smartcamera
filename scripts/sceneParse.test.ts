import { buildPrompt, parseRound } from "../src/scene";

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

const scene = ["person at desk", "green cup on desk", "headphones on head"];

console.log(`scene deltas:`);
check("nothing means nothing", parseRound("nothing", scene, false), { state: scene, added: [], removed: [] });
check("a new thing is added", parseRound("holding a phone", scene, false),
    { state: [...scene, "holding a phone"], added: ["holding a phone"], removed: [] });
check("gone by text removes", parseRound("gone: green cup on desk", scene, false),
    { state: ["person at desk", "headphones on head"], added: [], removed: ["green cup on desk"] });
check("gone by list number removes", parseRound("gone: 2", scene, false),
    { state: ["person at desk", "headphones on head"], added: [], removed: ["green cup on desk"] });
check("both at once", parseRound("gone: 3 | drinking from cup", scene, false),
    { state: ["person at desk", "green cup on desk", "drinking from cup"], added: ["drinking from cup"], removed: ["headphones on head"] });

// The failure that emptied the scene every other round: the model mirrors the list format it was
// shown, and a mirrored list must be a no-op rather than a mass deletion.
console.log(`\nechoing the list back changes nothing:`);
check("dash bulleted echo", parseRound(scene.map(item => `- ${item}`).join(" | "), scene, false),
    { state: scene, added: [], removed: [] });
check("numbered echo", parseRound(scene.map((item, index) => `${index + 1}. ${item}`).join(" | "), scene, false),
    { state: scene, added: [], removed: [] });
check("capitalised echo", parseRound(scene.map(item => item.toUpperCase()).join("|"), scene, false),
    { state: scene, added: [], removed: [] });
check("a bare dash is not a removal", parseRound("-|nothing", scene, false),
    { state: scene, added: [], removed: [] });

console.log(`\nfull description replaces:`);
check("full ignores prior state", parseRound("a cat|a mat", scene, true),
    { state: ["a cat", "a mat"], added: ["a cat", "a mat"], removed: [] });

console.log(`\nprompts:`);
check("empty scene asks for a description", buildPrompt([], false).startsWith("Describe this scene"), true);
check("known scene asks for changes", buildPrompt(scene, false).includes("report only what has changed"), true);
check("the scene is numbered, not dashed", buildPrompt(scene, false).includes("2. green cup on desk"), true);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
