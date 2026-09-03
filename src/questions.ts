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

/**
 * A phrase carries its own word, in parentheses at the end: "is eating pizza (pizza)".
 *
 * One string rather than a question and a keyword side by side. The word has to be visible wherever
 * the phrase is, since it is what the model actually answers and therefore the thing you tune when an
 * answer comes back wrong. Keeping it inside the phrase means every place that shows a phrase shows
 * it already, and there is one identity to pass around instead of a pair to keep together.
 */
export type Watch = {
    /** The whole thing, "is eating pizza (pizza)". This is the identity: what an entry reports. */
    phrase: string;
    /** What the model is asked, "is eating pizza". */
    question: string;
    /** What the model answers with, "pizza". */
    keyword: string;
};

/**
 * Asked from a cold start, and after every restart.
 *
 * Not kept on disk, on purpose: anything a caller adds lives only as long as the process, so a
 * watcher that has gone away takes its question with it. Persisting them meant the list only ever
 * grew, and each entry costs tokens on every single frame.
 */
export const DEFAULT_PHRASES = [
    "is a person present (person)",
    "is anyone drinking (drinking)",
    "is a hand on the mouse (mouse)",
    "is anyone typing (typing)",
    "is anyone eating (eating)",
    "is anyone wearing headphones (headphones)",
    "is wearing shirt (shirt)",
    "is the door open (door)",
    "is well lit (lit)",
    "head tilted back with hands on face (tilted)",
    "brushing teeth with electric toothbrush (toothbrush)",
];

/** Named because smartpause watches exactly this one, so a reword here cannot orphan it there. */
export const HEADPHONES_PHRASE = "is anyone wearing headphones (headphones)";

export const MAX_QUESTIONS = 26;
export const MAX_PHRASE_LENGTH = 140;
export const MAX_KEYWORD_LENGTH = 24;
/** Said instead of an empty answer. Checked as a word before anything is matched against it. */
const NONE_TRUE = /^(none|nothing|n\/a|no|empty)$/i;
/** The trailing "(word)". Nothing nested, because a keyword is one plain word. */
const WITH_KEYWORD = /^(.*?)\s*\(\s*([^()]*?)\s*\)$/;

export function normalizeQuestion(question: string): string {
    return question.replace(/\s+/g, " ").trim();
}

/** One lowercase word. Anything else would not survive being read back out of a reply. */
export function normalizeKeyword(keyword: string): string {
    return keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** The pure split, with no fallback. Undefined when there is no usable word in parentheses. */
function splitPhrase(phrase: string): Watch | undefined {
    const match = WITH_KEYWORD.exec(normalizeQuestion(phrase));
    if (!match) {
        return undefined;
    }
    const question = normalizeQuestion(match[1]);
    const keyword = normalizeKeyword(match[2]);
    if (!question || !keyword) {
        return undefined;
    }
    return { phrase: `${question} (${keyword})`, question, keyword };
}

export const DEFAULT_WATCHES: Watch[] = DEFAULT_PHRASES.map(phrase => {
    const watch = splitPhrase(phrase);
    if (!watch) {
        throw new Error(`the default ${JSON.stringify(phrase)} is missing its word in parentheses`);
    }
    return watch;
});

/**
 * "is eating pizza (pizza)" into its parts, or a refusal.
 *
 * Naming the word is the caller's job, since the caller is the one who finds out it was the wrong
 * word. A phrase arriving without one is only accepted if it is a default, which is what lets
 * anything already watching "is anyone wearing headphones" keep saying that and nothing else.
 *
 * Everything else is refused rather than given a word derived from its own. Deriving one was the
 * first attempt and it is quietly worse: the caller never agreed to the word, cannot see it without
 * asking, and finds out it clashed with another question only by getting answers meant for that one.
 */
export function parseWatch(phrase: string): Watch {
    const wanted = normalizeQuestion(phrase);
    if (!wanted) {
        throw new Error(`A phrase is required`);
    }
    if (wanted.length > MAX_PHRASE_LENGTH) {
        throw new Error(`A phrase must be at most ${MAX_PHRASE_LENGTH} characters`);
    }
    const split = splitPhrase(wanted);
    if (split) {
        if (split.keyword.length > MAX_KEYWORD_LENGTH) {
            throw new Error(`The word in parentheses must be at most ${MAX_KEYWORD_LENGTH} characters`);
        }
        return split;
    }
    const fallback = DEFAULT_WATCHES.find(watch => watch.question === wanted);
    if (fallback) {
        return { ...fallback };
    }
    throw new Error(`${JSON.stringify(wanted)} needs the word the model should answer with, in`
        + ` parentheses at the end, like "is eating pizza (pizza)"`);
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
    /** Phrases the model said were true. */
    yes: string[];
    /** Phrases it decided about at all. Empty when the reply made no sense. */
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
    const phrases = watches.map(watch => watch.phrase);
    const words = reply.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (words.length === 0) {
        return { yes: [], answered: [], unknown: [] };
    }
    // Everything was decided and nothing was true. Checked before any matching, since a keyword could
    // otherwise be found inside it.
    if (words.length === 1 && NONE_TRUE.test(words[0])) {
        return { yes: [], answered: [...phrases], unknown: [] };
    }

    const chosen: string[] = [];
    const unknown: string[] = [];
    for (const word of words) {
        const watch = watches.find(candidate => candidate.keyword === word);
        if (watch) {
            if (!chosen.includes(watch.phrase)) {
                chosen.push(watch.phrase);
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
        yes: phrases.filter(phrase => chosen.includes(phrase)),
        answered: [...phrases],
        unknown,
    };
}

/** What changed, by comparing two answer sets rather than by asking the model what changed. */
export function diffAnswers(before: string[], after: string[]): { added: string[]; removed: string[] } {
    return {
        added: after.filter(phrase => !before.includes(phrase)),
        removed: before.filter(phrase => !after.includes(phrase)),
    };
}

/**
 * An old bare question from a log file, as the phrase it is now.
 *
 * The day files predate the word being part of the phrase, so a week of history says "is a person
 * present" where today's rounds say "is a person present (person)". Left alone, the two would be
 * counted as separate conditions and a stat would be split down the middle at the moment of the
 * change. Only the defaults can be recovered this way, which is nearly all of what is in there.
 */
export function canonicalPhrase(written: string): string {
    const wanted = normalizeQuestion(written);
    return DEFAULT_WATCHES.find(watch => watch.question === wanted)?.phrase ?? wanted;
}
