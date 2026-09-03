import { buildPrompt, parseAnswers, diffAnswers } from "../src/questions";

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

const questions = ["is a person present", "is anyone drinking", "is a hand on the mouse"];
const yesOf = (reply: string) => parseAnswers(reply, questions).yes;

// However it chooses to punctuate it. A strict reader would throw away good answers over a comma.
console.log(`reading the answers:`);
check("plain", yesOf("A yes B no C yes"), ["is a person present", "is a hand on the mouse"]);
check("colons", yesOf("A: yes B: no C: yes"), ["is a person present", "is a hand on the mouse"]);
check("parens", yesOf("A) yes, B) no, C) yes"), ["is a person present", "is a hand on the mouse"]);
check("newlines", yesOf("A yes\nB no\nC yes"), ["is a person present", "is a hand on the mouse"]);
check("lowercase", yesOf("a yes b no c yes"), ["is a person present", "is a hand on the mouse"]);
check("y and n", yesOf("A y B n C y"), ["is a person present", "is a hand on the mouse"]);
check("all no", yesOf("A no B no C no"), []);
check("reported in the order asked", yesOf("C yes A yes B no"),
    ["is a person present", "is a hand on the mouse"]);
check("a letter with no question is ignored", yesOf("A yes Z yes"), ["is a person present"]);

// A question the model skipped is not a no. Treating it as one reports something leaving that
// nobody said had left.
console.log(`\nan unanswered question is not a no:`);
check("only two of three answered", parseAnswers("A yes B no", questions).answered,
    ["is a person present", "is anyone drinking"]);
check("and the third is not in yes", parseAnswers("A yes B no", questions).yes, ["is a person present"]);
check("nothing parseable at all", parseAnswers("I cannot tell", questions),
    { yes: [], answered: [] });

console.log(`\nchange is a flip, computed here:`);
check("turning on", diffAnswers([], ["is anyone drinking"]), { added: ["is anyone drinking"], removed: [] });
check("turning off", diffAnswers(["is anyone drinking"], []), { added: [], removed: ["is anyone drinking"] });
check("staying on", diffAnswers(["is anyone drinking"], ["is anyone drinking"]), { added: [], removed: [] });

console.log(`\nthe prompt:`);
const prompt = buildPrompt(questions);
check("questions are lettered", prompt.includes("B is anyone drinking"), true);
check("one line is asked for", prompt.includes("on one line"), true);
check("and shown by example", prompt.includes("A yes B no C yes"), true);

console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
