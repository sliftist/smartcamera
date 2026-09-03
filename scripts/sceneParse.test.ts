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
check("remove takes one out", parseRound("remove green cup on desk", scene, false),
    ["person at desk", "headphones on head"]);
check("several at once", parseRound("remove person at desk|remove headphones on head", scene, false),
    ["green cup on desk"]);
check("removing and adding together", parseRound("remove headphones on head | drinking from cup", scene, false),
    ["person at desk", "green cup on desk", "drinking from cup"]);
check("wording that drifted still matches", parseRound("remove the green cup", scene, false),
    ["person at desk", "headphones on head"]);
check("removing something absent does nothing", parseRound("remove a bicycle", scene, false), scene);

// Loose matching is the only handle on an item now that positions are gone, so its floor matters more
// than its reach. A wrong removal deletes something that is really there.
console.log(`\nloose, but not so loose it removes the wrong thing:`);
const hands = ["hand on mouse", "hand on keyboard", "person at desk"];
check("one shared word is not enough", parseRound("remove hand on trackpad", hands, false), hands);
check("two shared words is", parseRound("remove the hand on the mouse", hands, false),
    ["hand on keyboard", "person at desk"]);
check("an ambiguous match removes nothing",
    parseRound("remove hand", hands, false), hands);
check("a near miss on a different noun is refused",
    parseRound("remove person at door", hands, false), hands);

// The model is shown plain lines and told to say remove, so those are what it should send. The older
// spellings stay accepted, since a model reaches for its own wording sooner or later.
console.log(`\nother ways of saying it are still understood:`);
check("gone", parseRound("gone: green cup on desk", scene, false), ["person at desk", "headphones on head"]);
check("no longer", parseRound("no longer headphones on head", scene, false), ["person at desk", "green cup on desk"]);

// The model mirrors the shape of the list it was shown, so a mirrored list has to be a no-op rather
// than a mass deletion. With a dash as the removal marker it emptied the scene every other round.
console.log(`\nechoing the list back changes nothing:`);
check("plain echo", parseRound(scene.join(" | "), scene, false), scene);
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
const saidNo = parseRound("remove drinking | remove person at door", offered, false);
check("declining both leaves the scene alone", saidNo, scene);
check("declining is not a scene change", diffScenes(scene, saidNo), { added: [], removed: [] });
check("nothing matched", matchInterests(saidNo, interests), []);

const saidYes = parseRound("remove person at door", offered, false);
check("keeping one matches it", matchInterests(saidYes, interests), ["drinking"]);
check("and it reads as appearing", diffScenes(scene, saidYes), { added: ["drinking"], removed: [] });

console.log(`\nprompts:`);
check("empty scene asks for a description", buildPrompt([], false).startsWith("Describe this scene"), true);
check("known scene asks for changes", buildPrompt(scene, false).includes("report only what has changed"), true);
check("items are plain lines", buildPrompt(scene, false).includes("\ngreen cup on desk\n"), true);
check("nothing is numbered", /^\d+\./m.test(buildPrompt(scene, false)), false);
check("nothing is bulleted", /^[-*]/m.test(buildPrompt(scene, false)), false);
check("removal is a word with no punctuation after it",
    buildPrompt(scene, false).includes("Put remove in front of"), true);
check("pinned phrases are ordinary list items", buildPrompt(offered, false).includes("\ndrinking\n"), true);
check("and get no instruction of their own", buildPrompt(offered, false).toLowerCase().includes("exactly"), false);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
