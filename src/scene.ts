/**
 * Asking what changed, rather than asking what is there and paying for the answer every time.
 *
 * The first look at a scene is a full description. After that the model is handed what the scene held
 * a moment ago and asked only for the difference, so a still room costs one word and a room where
 * something happened costs a phrase about the thing that happened. Nothing else is re-stated, which
 * is the point: a model asked to list a scene it has already listed will list it the same way again,
 * and that stickiness was drowning out the one item that had actually changed.
 *
 * The risk this trades into is drift. If the model never reports something leaving, it stays in the
 * state forever. So every so often the question goes back to a full description and the state is
 * replaced outright, which is the same bargain a video stream makes with keyframes.
 *
 * What this module returns is the scene after the model's reply has been applied, and nothing about
 * what the model claimed. What changed is worked out by comparing that against the scene before it,
 * which is a fact rather than a report, and is the only version worth showing anyone.
 */

/** Scene contents carried between rounds. A cap only bounds the prompt; a real scene is far smaller. */
export const MAX_STATE = 16;
/** Rounds between full descriptions, which throw away accumulated drift and start the state again. */
export const FULL_DESCRIBE_EVERY = 20;
const MAX_WORDS = 6;
/**
 * Removals are marked by a word, not by punctuation.
 *
 * A dash cannot do this job. The scene has to be shown to the model as a list, the model writes its
 * answer in whatever shape that list was in, and a restated item then arrives looking exactly like a
 * deletion. That is not hypothetical: with a dash it emptied the scene every second round and spent
 * its time describing the same room over and over.
 */
// A comma is allowed after the word because it writes "remove,f" as readily as "remove f", and a
// removal that fails to parse becomes an addition of its own text. "left" is deliberately not here:
// "left hand on mouse" is a thing a camera sees, not a removal.
const REMOVAL = /^(remove|removed|gone|no longer)\s*[,:]?\s*/i;
/** A letter the model tagged an item with, as in "C hand on mouse". Uppercase only, so "a cat" survives. */
const LETTER_TAG = /^[A-Z][\s,.:)\]]+/;
/**
 * Stripped off the front of an item before anything else. Bullets and numbers included, so that an
 * answer which just echoes the list back lands on the items already in the scene and changes nothing,
 * which is the harmless way for the model to ignore the instruction.
 */
const LEADING_MARKER = /^(?:[-−–—*\d.)\]]+\s*)+/;
const NOTHING = /^(nothing|no change|none|unchanged|same|nothing has changed)$/i;

/** Normalized the same way scene items are, so a caller's phrase and a model's answer compare equal. */
export function normalizePhrase(phrase: string): string {
    return phrase
        .replace(LETTER_TAG, "")
        .replace(LEADING_MARKER, "")
        .replace(/[.,;]+$/, "")
        .trim()
        .toLowerCase();
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** What the answer about pinned phrases is anchored on, so it can be found wherever it lands. */
const ANSWER_TOKEN = "TRUE=";
const ANSWER_PATTERN = /TRUE\s*=\s*/i;
const NO_LETTERS = /^(none|nothing|n\/a|no)\b/i;

export function letterFor(index: number): string {
    return LETTERS[index] ?? "?";
}

/**
 * A separate question, answered separately.
 *
 * Pinned phrases used to be slipped into the scene list as ordinary items, on the theory that the
 * model would then keep the caller's exact wording for free. It did not. It never integrated them,
 * spent most of every reply declining the same five, and flickered on the marginal ones. Asked
 * directly which of a lettered list are true, it just answers, and the answer costs a letter.
 *
 * The deltas a caller sees for these are worked out here rather than reported by the model, the same
 * way scene changes are.
 */
function interestQuestion(interests: string[]): string[] {
    if (interests.length === 0) {
        return [];
    }
    return [
        ``,
        `Separately, decide which of these are true in the image right now:`,
        ...interests.map((interest, index) => `${letterFor(index)} ${interest}`),
    ];
}

function outputInstruction(interests: string[]): string[] {
    if (interests.length === 0) {
        return [``, `Write everything on one line separated by | and write nothing else.`];
    }
    // Anchored on a token rather than on being the second line. Asked for two lines it put a newline
    // between every item instead, mixed the letters into the changes, and split them across lines, so
    // there was no line to point at. A token can be found wherever it ends up.
    return [
        ``,
        `Write the changes separated by |`,
        `Then write ${ANSWER_TOKEN} followed by the letters that are true, with no spaces.`,
        `Write ${ANSWER_TOKEN}none if none of them are true.`,
    ];
}

export function buildPrompt(scene: string[], interests: string[], full: boolean): string {
    if (full || scene.length === 0) {
        return [
            `Describe this scene as a list of the objects in it and the actions happening.`,
            `Briefly describe each object, and say what each person is doing.`,
            `Keep each one to a short phrase of at most ${MAX_WORDS} words.`,
            ...interestQuestion(interests),
            ...outputInstruction(interests),
        ].join("\n");
    }
    // Plain lines, no numbers and no bullets. A numbered list gets answered by number, and a position
    // is a worse thing to be handed than the text: it means nothing on its own, it has to be resolved
    // against exactly the list that was sent, and getting that resolution wrong silently deletes the
    // wrong item. The text says what it means and matches whatever it matches.
    return [
        `A moment ago this scene held:`,
        ...scene,
        ``,
        `Look at the image now and report only what has changed.`,
        `Write anything new as a short phrase of at most ${MAX_WORDS} words.`,
        `Put remove in front of anything above that is no longer true.`,
        `Do not repeat anything above that is still true.`,
        `If nothing has changed, write: nothing`,
        ...interestQuestion(interests),
        ...outputInstruction(interests),
    ].join("\n");
}

/** Lowercase and stripped of list punctuation, so the same phrase twice is one entry. */
const normalize = normalizePhrase;

/** Words that carry no meaning on their own, so they should not make two phrases look alike. */
const NOISE_WORDS = new Set(["a", "an", "the", "of", "on", "in", "at", "to", "is", "are", "with", "and", "his", "her", "their"]);

function meaningfulWords(phrase: string): Set<string> {
    return new Set(phrase.split(/[^a-z0-9]+/).filter(word => word && !NOISE_WORDS.has(word)));
}

/**
 * Matched loosely, and it has to be: the text is the only handle on an item now, and the model rarely
 * quotes one back word for word. It says "remove the green cup" for "green cup on desk".
 *
 * Loose has a floor though. Two meaningful words have to line up, so "hand on mouse" does not answer
 * for "hand on keyboard" on the strength of the word hand, and an ambiguous best match removes
 * nothing rather than guessing, since a wrong removal deletes something that is really there.
 */
function findByText(item: string, state: string[]): string | undefined {
    const exact = state.find(candidate => candidate === item);
    if (exact) {
        return exact;
    }
    // One containment is a match; two is a question. "remove hand" sits inside both "hand on mouse"
    // and "hand on keyboard", and picking whichever came first would be a coin toss over which real
    // thing to delete.
    const contained = state.filter(candidate => candidate.includes(item) || item.includes(candidate));
    if (contained.length === 1) {
        return contained[0];
    }
    if (contained.length > 1) {
        return undefined;
    }
    const wanted = meaningfulWords(item);
    let best: string | undefined;
    let bestScore = 1;
    let tied = false;
    for (const candidate of state) {
        let score = 0;
        for (const word of meaningfulWords(candidate)) {
            if (wanted.has(word)) {
                score++;
            }
        }
        if (score > bestScore) {
            best = candidate;
            bestScore = score;
            tied = false;
        } else if (score === bestScore && best) {
            tied = true;
        }
    }
    return tied ? undefined : best;
}

/** The scene as it stands once the model's reply has been applied to what it was shown. */
export function parseRound(reply: string, offered: string[], full: boolean): string[] {
    // A full description replaces the scene rather than amending it, so nothing carries over.
    let next = full ? [] : [...offered];

    for (const piece of reply.split("|")) {
        const trimmed = piece.trim();
        if (!trimmed || NOTHING.test(normalize(trimmed))) {
            continue;
        }
        if (!full && REMOVAL.test(trimmed)) {
            const item = normalize(trimmed.replace(REMOVAL, ""));
            const match = item && findByText(item, next);
            if (match) {
                next = next.filter(candidate => candidate !== match);
            }
            continue;
        }
        const item = normalize(trimmed);
        // Already present means the model restated something still true, which the prompt asks it not
        // to do. Not an error and not news, so it changes nothing.
        if (!item || next.includes(item)) {
            continue;
        }
        // A single character is never a description of anything. It is a stray letter from the pinned
        // phrase answer that got past the split, and letting one in is how the scene came to hold "c".
        if (item.length < 2) {
            continue;
        }
        next.push(item);
    }

    return next.slice(-MAX_STATE);
}

/**
 * What actually changed, by comparing the two scenes rather than by believing a report.
 *
 * The model's own account of what it changed cannot be used for this. Pinned phrases are offered to it
 * every round, so it announces their removal every round they are not happening, and none of that is
 * a change in the scene: it is the answer to a question we asked. Diffing the before against the after
 * gets that right without having to special case it, and stays right whatever the model does.
 */
export function diffScenes(before: string[], after: string[]): { added: string[]; removed: string[] } {
    return {
        added: after.filter(item => !before.includes(item)),
        removed: before.filter(item => !after.includes(item)),
    };
}

/**
 * Splits a reply into the scene changes and the pinned phrases the model says are true.
 *
 * The letters are expanded to their phrases here and the answer is cut out of the text before the
 * changes are parsed. Both halves of that matter. A letter is an encoding between this and the model
 * and must never reach anything downstream, and if the answer is left in the text it is read as a
 * scene item: the scene really did end up holding "c", "f" and "f wearing headphones on head".
 */
export function splitReply(reply: string, interests: string[]): { changes: string; matched: string[] } {
    const flattened = reply.replace(/\r?\n/g, " | ");
    if (interests.length === 0) {
        return { changes: flattened, matched: [] };
    }
    const answer = ANSWER_PATTERN.exec(flattened);
    if (!answer) {
        return { changes: flattened, matched: [] };
    }
    const tail = flattened.slice(answer.index + answer[0].length);
    if (NO_LETTERS.test(tail)) {
        // Spelled out rather than left empty. Reading it letter by letter would match whatever "none"
        // happens to spell, and with seven phrases pinned the e in none is "arms crossed".
        return { changes: flattened.slice(0, answer.index), matched: [] };
    }
    // It separates them however it likes: TRUE=CF, TRUE=C F, TRUE=C|F. Tokens are taken while they
    // still read as letters and abandoned at the first one that does not, so anything the model wrote
    // after the answer stays out of it.
    const matched: string[] = [];
    let consumed = 0;
    for (const token of tail.split(/([^A-Za-z]+)/)) {
        if (/^[^A-Za-z]*$/.test(token)) {
            consumed += token.length;
            continue;
        }
        const letters = [...token.toUpperCase()].map(character => LETTERS.indexOf(character));
        if (letters.some(index => index < 0 || index >= interests.length)) {
            break;
        }
        for (const index of letters) {
            if (!matched.includes(interests[index])) {
                matched.push(interests[index]);
            }
        }
        consumed += token.length;
    }
    // Only the span actually read as the answer is cut, so a reply that put changes after it keeps them.
    const changes = flattened.slice(0, answer.index) + " " + tail.slice(consumed);
    return { changes, matched };
}
