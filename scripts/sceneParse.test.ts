import { buildPrompt, parseRound, offeredScene, diffScenes, matchInterests } from "../src/scene";

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

console.log(`applying a reply to the offered list:`);
check("nothing changes nothing", parseRound("nothing", scene, false), scene);
check("a new thing is appended", parseRound("holding a phone", scene, false), [...scene, "holding a phone"]);
check("gone by text removes", parseRound("gone: green cup on desk", scene, false),
    ["person at desk", "headphones on head"]);
check("gone by list number removes", parseRound("gone: 2", scene, false),
    ["person at desk", "headphones on head"]);
check("both at once", parseRound("gone: 3 | drinking from cup", scene, false),
    ["person at desk", "green cup on desk", "drinking from cup"]);

// The failure that emptied the scene every other round: the model mirrors the list format it was
// shown, and a mirrored list must be a no-op rather than a mass deletion.
console.log(`\nechoing the list back changes nothing:`);
check("dash bulleted echo", parseRound(scene.map(item => `- ${item}`).join(" | "), scene, false), scene);
check("numbered echo", parseRound(scene.map((item, index) => `${index + 1}. ${item}`).join(" | "), scene, false), scene);
check("capitalised echo", parseRound(scene.map(item => item.toUpperCase()).join("|"), scene, false), scene);
check("a bare dash is not a removal", parseRound("-|nothing", scene, false), scene);

console.log(`\nfull description replaces:`);
check("full ignores what it was shown", parseRound("a cat|a mat", scene, true), ["a cat", "a mat"]);

console.log(`\nchange is a diff, never the model's account of one:`);
check("appearing", diffScenes(scene, [...scene, "drinking"]), { added: ["drinking"], removed: [] });
check("leaving", diffScenes(scene, scene.slice(0, 2)), { added: [], removed: ["headphones on head"] });
check("a still scene", diffScenes(scene, [...scene]), { added: [], removed: [] });

console.log(`\nphrases of interest ride in the scene list:`);
const interests = ["drinking", "person at door"];
const offered = offeredScene(scene, interests);
check("both are offered to the model", offered, [...scene, "drinking", "person at door"]);
check("an interest already in the scene is not offered twice",
    offeredScene([...scene, "drinking"], interests), [...scene, "drinking", "person at door"]);

// The model says the pinned phrases are not happening, every round, because it is asked every round.
// That is an answer, not a change, and the diff against the real scene has to stay empty.
const saidNo = parseRound("gone: drinking | gone: person at door", offered, false);
check("declining both leaves the scene alone", saidNo, scene);
check("declining is not a scene change", diffScenes(scene, saidNo), { added: [], removed: [] });
check("nothing matched", matchInterests(saidNo, interests), []);

const saidYes = parseRound("gone: person at door", offered, false);
check("keeping one matches it", matchInterests(saidYes, interests), ["drinking"]);
check("and it reads as appearing", diffScenes(scene, saidYes), { added: ["drinking"], removed: [] });

console.log(`\nprompts:`);
check("empty scene asks for a description", buildPrompt([], false).startsWith("Describe this scene"), true);
check("known scene asks for changes", buildPrompt(scene, false).includes("report only what has changed"), true);
check("the scene is numbered, not dashed", buildPrompt(scene, false).includes("2. green cup on desk"), true);
check("pinned phrases appear as ordinary list items", buildPrompt(offered, false).includes("4. drinking"), true);
check("and get no instruction of their own", buildPrompt(offered, false).toLowerCase().includes("exactly"), false);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
