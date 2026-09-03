import { buildPrompt, parseAnswers, diffAnswers, parseWatch, canonicalPhrase, normalizeKeyword, DEFAULT_WATCHES, Watch } from "../src/questions";

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

function refuses(label: string, run: () => unknown) {
    try {
        run();
        failures++;
        console.log(`  FAIL ${label}`);
        console.log(`         it was accepted`);
    } catch {
        console.log(`  ok   ${label}`);
    }
}

const watches: Watch[] = [
    "is a person present (person)",
    "is anyone drinking (drinking)",
    "is a hand on the mouse (mouse)",
    "is anyone typing (typing)",
].map(parseWatch);
const phrases = watches.map(watch => watch.phrase);

console.log(`parsing a phrase`);
check("splits on the trailing parentheses", parseWatch("is eating pizza (pizza)"),
    { phrase: "is eating pizza (pizza)", question: "is eating pizza", keyword: "pizza" });
check("tidies the spacing on the way in", parseWatch("  is   eating pizza  (  Pizza )  ").phrase,
    "is eating pizza (pizza)");
check("a keyword is one lowercase word", normalizeKeyword("  Hot-Dog!  "), "hotdog");
check("a default needs no parentheses", parseWatch("is anyone drinking").phrase,
    "is anyone drinking (drinking)");
check("and keeps its own word", parseWatch("is anyone drinking").keyword, "drinking");
// The whole point of the change: nothing gets a word it never agreed to.
refuses("anything else without a word is refused", () => parseWatch("is the kettle on"));
refuses("so is an empty word", () => parseWatch("is the kettle on ()"));
refuses("so is a word with no question", () => parseWatch("(kettle)"));
refuses("so is nothing at all", () => parseWatch("   "));
refuses("so is a phrase past the length limit", () => parseWatch(`${"x".repeat(200)} (long)`));
check("every default carries its own word", DEFAULT_WATCHES.every(watch => watch.keyword.length > 0), true);
check("and no two share one", new Set(DEFAULT_WATCHES.map(watch => watch.keyword)).size, DEFAULT_WATCHES.length);

console.log(`the prompt`);
const prompt = buildPrompt(watches);
check("maps each word to its question", prompt.includes("mouse: is a hand on the mouse"), true);
check("shows the parentheses to nobody", prompt.includes("("), false);
check("asks for words only", prompt.includes("Write only the words of the ones that are true"), true);
check("gives an example from the list", prompt.includes("Like this: person drinking"), true);

console.log(`reading a reply`);
check("the words it said are true", parseAnswers("person typing", watches).yes,
    ["is a person present (person)", "is anyone typing (typing)"]);
check("and everything is decided", parseAnswers("person typing", watches).answered, phrases);
check("reported in the order asked", parseAnswers("typing person", watches).yes,
    ["is a person present (person)", "is anyone typing (typing)"]);
check("none means nothing is true", parseAnswers("none", watches).yes, []);
check("but everything was still decided", parseAnswers("none", watches).answered, phrases);
check("a repeat is not counted twice", parseAnswers("person person", watches).yes,
    ["is a person present (person)"]);
check("commas and newlines are separators too", parseAnswers("person,\ntyping", watches).yes,
    ["is a person present (person)", "is anyone typing (typing)"]);
check("case is ignored", parseAnswers("Person TYPING", watches).yes,
    ["is a person present (person)", "is anyone typing (typing)"]);

console.log(`words that were never offered`);
check("are kept", parseAnswers("person phone", watches).unknown, ["phone"]);
check("without losing the ones that were", parseAnswers("person phone", watches).yes,
    ["is a person present (person)"]);
check("and are not repeated", parseAnswers("phone phone person", watches).unknown, ["phone"]);
// A reply about something else entirely, rather than an answer that everything is false. Saying
// nothing is true would report every watch as having stopped.
check("a reply with nothing recognisable answers nothing", parseAnswers("I cannot see the image", watches).answered, []);
check("and is still reported", parseAnswers("I cannot see the image", watches).unknown.includes("image"), true);
check("an empty reply answers nothing", parseAnswers("", watches).answered, []);

console.log(`what changed`);
check("added", diffAnswers(["a"], ["a", "b"]).added, ["b"]);
check("removed", diffAnswers(["a", "b"], ["b"]).removed, ["a"]);
check("nothing", diffAnswers(["a"], ["a"]), { added: [], removed: [] });

console.log(`old log lines`);
// The day files straddle the change, so a week of history says it both ways.
check("a bare default becomes its phrase", canonicalPhrase("is a person present"), "is a person present (person)");
check("one that already has its word is left alone", canonicalPhrase("is a person present (person)"),
    "is a person present (person)");
check("and anything else is left as written", canonicalPhrase("is the kettle on"), "is the kettle on");

console.log(failures === 0 ? `\nall good` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
