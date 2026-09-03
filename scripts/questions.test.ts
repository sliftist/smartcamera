import { buildPrompt, parseAnswers, diffAnswers, deriveKeyword, defaultKeywordFor, normalizeKeyword, DEFAULT_WATCHES, Watch } from "../src/questions";

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

const watches: Watch[] = [
    { keyword: "person", question: "is a person present" },
    { keyword: "drinking", question: "is anyone drinking" },
    { keyword: "mouse", question: "is a hand on the mouse" },
];
const yesOf = (reply: string) => parseAnswers(reply, watches).yes;

console.log(`reading the words back:`);
check("two of them", yesOf("person mouse"), ["is a person present", "is a hand on the mouse"]);
check("one", yesOf("drinking"), ["is anyone drinking"]);
check("in the order asked, not the order said", yesOf("mouse person"),
    ["is a person present", "is a hand on the mouse"]);
check("commas and newlines", yesOf("person,\nmouse"), ["is a person present", "is a hand on the mouse"]);
check("case does not matter", yesOf("PERSON Mouse"), ["is a person present", "is a hand on the mouse"]);
check("none is a word", yesOf("none"), []);
check("and none means everything was decided", parseAnswers("none", watches).answered,
    watches.map(watch => watch.question));
check("naming some means the rest are no", parseAnswers("person", watches).answered,
    watches.map(watch => watch.question));

// A stray word is the model saying what it thinks it sees. Kept, because it is information.
console.log(`\nwords that were never offered:`);
check("kept alongside the real ones", parseAnswers("person phone", watches).unknown, ["phone"]);
check("without disturbing the answer", parseAnswers("person phone", watches).yes, ["is a person present"]);
check("nothing recognised at all is not an answer", parseAnswers("I cannot tell", watches).answered, []);
check("but is still reported", parseAnswers("a cat", watches).unknown, ["a", "cat"]);
check("an empty reply says nothing", parseAnswers("", watches), { yes: [], answered: [], unknown: [] });

console.log(`\nkeywords:`);
check("a built in question knows its own", defaultKeywordFor("is anyone drinking"), "drinking");
check("and an unknown one does not", defaultKeywordFor("is the kettle on"), undefined);
check("derived from the meaningful end", deriveKeyword("is anyone holding a phone", []), "phone");
check("skipping the filler words", deriveKeyword("is there a person at the door", []), "door");
// Two questions sharing a word would make an answer ambiguous about which one it meant. Another word
// from the same question is tried before a digit is resorted to.
check("a clash takes another word from the question", deriveKeyword("is the door open", ["door"]), "open");
check("and only then a digit", deriveKeyword("is the door open", ["door", "open"]), "open2");
check("keywords are one lowercase word", normalizeKeyword("  Hand-On Mouse! "), "handonmouse");

console.log(`\nchange is a flip, computed here:`);
check("turning on", diffAnswers([], ["is anyone drinking"]), { added: ["is anyone drinking"], removed: [] });
check("turning off", diffAnswers(["is anyone drinking"], []), { added: [], removed: ["is anyone drinking"] });
check("staying on", diffAnswers(["is anyone drinking"], ["is anyone drinking"]), { added: [], removed: [] });

console.log(`\nthe prompt:`);
const prompt = buildPrompt(watches);
check("pairs each word with its question", prompt.includes("drinking: is anyone drinking"), true);
check("asks for only the true words", prompt.includes("only the words of the ones that are true"), true);
check("with none as the empty answer", prompt.includes("Write none if none of them are true"), true);
check("and never asks for yes or no", /\byes\b/.test(prompt), false);

console.log(`\nthe defaults:`);
check("every one has a keyword", DEFAULT_WATCHES.every(watch => watch.keyword.length > 0), true);
check("and no two share one",
    new Set(DEFAULT_WATCHES.map(watch => watch.keyword)).size, DEFAULT_WATCHES.length);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
