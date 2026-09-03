import { buildPrompt, parseRound, splitReply, diffScenes } from "../src/scene";

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

// Pinned phrases are a separate question with a lettered answer. Slipping them into the scene list
// did not work: the model never integrated them, spent most of a reply declining the same ones, and
// flickered on the marginal ones. The letters are an encoding between here and the model only.
console.log(`\npinned phrases are answered by letter, expanded here:`);
const interests = ["drinking", "person at door", "hand on mouse"];
const matchOf = (reply: string) => splitReply(reply, interests).matched;
check("letters expand to phrases", matchOf("nothing TRUE=AC"), ["drinking", "hand on mouse"]);
check("lowercase", matchOf("nothing true=b"), ["person at door"]);
check("spaces around it", matchOf("nothing TRUE = B"), ["person at door"]);
check("none", matchOf("nothing TRUE=none"), []);
check("separated by pipes", matchOf("nothing TRUE=A|C"), ["drinking", "hand on mouse"]);
check("separated by spaces", matchOf("nothing TRUE=A C"), ["drinking", "hand on mouse"]);
check("no answer at all", matchOf("remove arms crossed"), []);
check("a token that is not letters ends the answer", matchOf("nothing TRUE=A remove the cup"), ["drinking"]);

// "none" spelled out must not be read letter by letter. With seven phrases pinned the e in none is
// the fifth of them, so reading it that way reports something nobody is doing.
const seven = ["eating food", "drinking from cup", "hand on mouse", "typing on keyboard",
    "arms crossed", "wearing headphones on head", "brushing teeth"];
check("none is a word, not five letters", splitReply("nothing TRUE=none", seven).matched, []);
check("and the e in it is not arms crossed", splitReply("nothing TRUE=none", seven).matched.includes("arms crossed"), false);
check("a real answer against the same list", splitReply("nothing TRUE=CF", seven).matched,
    ["hand on mouse", "wearing headphones on head"]);
check("with nothing pinned nothing is looked for", splitReply("nothing", []),
    { changes: "nothing", matched: [] });

// The answer must be cut out of the text, or it is read as a scene item. That is exactly how the
// scene came to hold "c", "f" and "f wearing headphones on head".
console.log(`\nthe answer never reaches the scene:`);
const scened = (reply: string) => parseRound(splitReply(reply, interests).changes, scene, false);
check("a letter answer adds nothing", scened("nothing TRUE=AC"), scene);
check("even split across lines", scened("nothing\nTRUE=AC"), scene);
check("alongside a real change", scened("holding a phone TRUE=A"), [...scene, "holding a phone"]);
check("a stray single letter is never an item", parseRound("c|f|holding a phone", scene, false),
    [...scene, "holding a phone"]);

// What the model actually writes into the changes half once it has letters in hand.
console.log(`\nletter debris in the changes half:`);
check("a comma after remove still removes", parseRound("remove,green cup on desk", scene, false),
    ["person at desk", "headphones on head"]);
check("a letter tag on an item is stripped", parseRound("C holding a phone", scene, false),
    [...scene, "holding a phone"]);
check("a letter tagged removal still removes", parseRound("remove,C green cup on desk", scene, false),
    ["person at desk", "headphones on head"]);
check("left is not a removal word", parseRound("left hand on mouse", scene, false),
    [...scene, "left hand on mouse"]);

console.log(`\na pinned phrase turning on reads as a change:`);
check("appearing", diffScenes([...scene], [...scene, "drinking"]), { added: ["drinking"], removed: [] });
check("going away", diffScenes([...scene, "drinking"], [...scene]), { added: [], removed: ["drinking"] });
check("staying on is not a change", diffScenes([...scene, "drinking"], [...scene, "drinking"]),
    { added: [], removed: [] });

console.log(`\nprompts:`);
check("empty scene asks for a description", buildPrompt([], [], false).startsWith("Describe this scene"), true);
check("known scene asks for changes", buildPrompt(scene, [], false).includes("report only what has changed"), true);
check("items are plain lines", buildPrompt(scene, [], false).includes("\ngreen cup on desk\n"), true);
check("nothing is numbered", /^\d+\./m.test(buildPrompt(scene, [], false)), false);
check("nothing is bulleted", /^[-*]/m.test(buildPrompt(scene, [], false)), false);
check("removal is a word with no punctuation after it",
    buildPrompt(scene, [], false).includes("Put remove in front of"), true);
check("pinned phrases are asked as a lettered question", buildPrompt(scene, interests, false).includes("A drinking"), true);
check("and are kept out of the scene list", buildPrompt(scene, interests, false).includes("\ndrinking\n"), false);
check("an anchored answer is asked for", buildPrompt(scene, interests, false).includes("TRUE="), true);
check("with none pinned there is one line", buildPrompt(scene, [], false).includes("on one line"), true);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
