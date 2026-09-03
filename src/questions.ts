/**
 * A fixed questionnaire, asked of every frame, answered with the words of whatever is true.
 *
 * This replaced asking the model to describe the scene, which produced text nobody could act on: the
 * wording drifted every round so the same fact never looked the same twice.
 *
 * The answer is the words of the true ones and nothing else. Two things follow from that, and both
 * matter. Anything left out is a no, so a still room costs a couple of tokens rather than one per
 * question whether or not anything is happening, and generating was a third of a frame's cost.
 *
 * The words are words rather than letters on purpose. A letter is the same one token and the model
 * has to hold a lookup table in its head to use one; "drinking" it can simply reason about. It also
 * means a wrong answer is legible: a stray letter tells you nothing, a stray word tells you what it
 * thought it saw, which is why unrecognised words are kept and shown rather than dropped.
 */

export type Watch = {
    question: string;
    /** The single word the model answers with. */
    keyword: string;
};

/**
 * Asked from a cold start, and after every restart.
 *
 * Not kept on disk, on purpose: anything a caller adds lives only as long as the process, so a
 * watcher that has gone away takes its question with it. Persisting them meant the list only ever
 * grew, and each entry costs tokens on every single frame.
 */
export const DEFAULT_WATCHES: Watch[] = [
    { keyword: "person", question: "is a person present" },
    { keyword: "drinking", question: "is anyone drinking" },
    { keyword: "mouse", question: "is a hand on the mouse" },
    { keyword: "typing", question: "is anyone typing" },
    { keyword: "eating", question: "is anyone eating" },
    { keyword: "headphones", question: "is anyone wearing headphones" },
    { keyword: "shirt", question: "is wearing shirt" },
    { keyword: "door", question: "is the door open" },
    { keyword: "lit", question: "is well lit" },
    { keyword: "tilted", question: "head tilted back with hands on face" },
];

/** Named because smartpause watches exactly this one, so a reword here cannot orphan it there. */
export const HEADPHONES_QUESTION = "is anyone wearing headphones";

export const MAX_QUESTIONS = 26;
export const MAX_QUESTION_LENGTH = 120;
export const MAX_KEYWORD_LENGTH = 24;
/** Said instead of an empty answer. Checked as a word before anything is matched against it. */
const NONE_TRUE = /^(none|nothing|n\/a|no|empty)$/i;
/** Too common to tell one question from another, so never derived as a keyword. */
const WEAK_WORDS = new Set([
    "is", "are", "a", "an", "the", "of", "on", "in", "at", "to", "with", "and", "or",
    "any", "anyone", "anything", "someone", "something", "there", "present", "has", "have",
    "his", "her", "their", "it", "its", "this", "that", "being", "doing",
]);

export function normalizeQuestion(question: string): string {
    return question.replace(/\s+/g, " ").trim();
}

/** One lowercase word. Anything else would not survive being read back out of a reply. */
export function normalizeKeyword(keyword: string): string {
    return keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * A keyword for a question that arrived without one.
 *
 * Callers are meant to name their own, and a built in question is looked up rather than derived. This
 * is the fallback for everything else: the first word carrying any meaning, since "is anyone holding
 * a phone" is about phones and not about anyone. Uniqueness matters more than elegance here, because
 * two questions sharing a word makes an answer ambiguous, so a clash gets a digit.
 */
export function deriveKeyword(question: string, taken: string[]): string {
    const words = normalizeQuestion(question).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const meaningful = words.filter(word => !WEAK_WORDS.has(word));
    // From the end, because the subject is usually last: "is anyone holding a phone" is about phones.
    // A different word from the same question beats a digit, so all of them are tried before that.
    for (const candidate of [...meaningful].reverse()) {
        const word = normalizeKeyword(candidate).slice(0, MAX_KEYWORD_LENGTH);
        if (word && !taken.includes(word)) {
            return word;
        }
    }
    let base = normalizeKeyword(meaningful[meaningful.length - 1] ?? words[0] ?? "watch").slice(0, MAX_KEYWORD_LENGTH);
    if (!base) {
        base = "watch";
    }
    if (!taken.includes(base)) {
        return base;
    }
    for (let suffix = 2; suffix < 100; suffix++) {
        if (!taken.includes(`${base}${suffix}`)) {
            return `${base}${suffix}`;
        }
    }
    return `${base}${Date.now() % 1000}`;
}

/** The keyword a built in question already has, so an old caller naming one needs to know nothing. */
export function defaultKeywordFor(question: string): string | undefined {
    return DEFAULT_WATCHES.find(watch => watch.question === normalizeQuestion(question))?.keyword;
}

export function buildPrompt(watches: Watch[]): string {
    return [
        `For each of the following, decide whether it is true of this image.`,
        ``,
        ...watches.map(watch => `${watch.keyword}: ${watch.question}`),
        ``,
        `Write only the words of the ones that are true, separated by spaces, and nothing else.`,
        `Write none if none of them are true.`,
        `Like this: ${watches.slice(0, 2).map(watch => watch.keyword).join(" ") || "none"}`,
    ].join("\n");
}

export type Answers = {
    /** Questions the model said were true. */
    yes: string[];
    /** Questions it decided about at all. Empty when the reply made no sense. */
    answered: string[];
    /**
     * Words it used that were never offered.
     *
     * Kept rather than dropped. A model answering "phone" when nothing was asked about phones is
     * telling you what it thinks it is looking at, which is worth seeing and possibly worth adding.
     */
    unknown: string[];
};

export function parseAnswers(reply: string, watches: Watch[]): Answers {
    const questions = watches.map(watch => watch.question);
    const words = reply.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length === 0) {
        return { yes: [], answered: [], unknown: [] };
    }
    // Everything was decided and nothing was true. Checked before any matching, since a keyword could
    // otherwise be found inside it.
    if (words.length === 1 && NONE_TRUE.test(words[0])) {
        return { yes: [], answered: [...questions], unknown: [] };
    }

    const chosen: string[] = [];
    const unknown: string[] = [];
    for (const word of words) {
        const watch = watches.find(candidate => candidate.keyword === word);
        if (watch) {
            if (!chosen.includes(watch.question)) {
                chosen.push(watch.question);
            }
        } else if (!unknown.includes(word)) {
            unknown.push(word);
        }
    }
    // Nothing recognised at all is a reply about something else, not an answer that everything is
    // false. Reported as no answer, so a caller keeps what it had rather than being told it all ended.
    if (chosen.length === 0 && unknown.length > 0) {
        return { yes: [], answered: [], unknown };
    }
    return {
        // In the order asked, so two rounds are comparable by eye.
        yes: questions.filter(question => chosen.includes(question)),
        answered: [...questions],
        unknown,
    };
}

/** What changed, by comparing two answer sets rather than by asking the model what changed. */
export function diffAnswers(before: string[], after: string[]): { added: string[]; removed: string[] } {
    return {
        added: after.filter(question => !before.includes(question)),
        removed: before.filter(question => !after.includes(question)),
    };
}
