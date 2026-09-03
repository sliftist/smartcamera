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
const REMOVAL = /^(remove|removed|gone|no longer|left)\s*:?\s+/i;
/**
 * Stripped off the front of an item before anything else. Bullets and numbers included, so that an
 * answer which just echoes the list back lands on the items already in the scene and changes nothing,
 * which is the harmless way for the model to ignore the instruction.
 */
const LEADING_MARKER = /^(?:[-−–—*\d.)\]]+\s*)+/;
const NOTHING = /^(nothing|no change|none|unchanged|same|nothing has changed)$/i;

/** Normalized the same way scene items are, so a caller's phrase and a model's answer compare equal. */
export function normalizePhrase(phrase: string): string {
    return phrase.replace(LEADING_MARKER, "").replace(/[.,;]+$/, "").trim().toLowerCase();
}

/**
 * The list the model is actually shown: the scene, plus every pinned phrase that is not already in it.
 *
 * This is the whole mechanism for phrases of interest, and it needs no instruction of its own. A
 * pinned phrase sits in the list like anything else, so the model answers the question it is already
 * being asked about everything else: is this still true? If it is not, it says so and the phrase is
 * simply absent this round. Telling the model about the phrases in prose instead does not work; asked
 * that way it answered with nothing but the pinned list, having read it as the answer sheet.
 */
export function offeredScene(state: string[], interests: string[]): string[] {
    return [...state, ...interests.filter(interest => !state.includes(interest))];
}

export function buildPrompt(offered: string[], full: boolean): string {
    if (full || offered.length === 0) {
        return [
            `Describe this scene as a list of the objects in it and the actions happening.`,
            `Briefly describe each object, and say what each person is doing.`,
            `Keep each one to a short phrase of at most ${MAX_WORDS} words.`,
            ``,
            `Write them on one line separated by | and write nothing else.`,
        ].join("\n");
    }
    // Pinned phrases sit in this list exactly like anything else, with no marking to say they are
    // different. That is what makes the model keep the caller's wording: it is being shown the phrase
    // as something already true of the scene, so confirming it costs nothing and rewording it does.
    // Plain lines, no numbers and no bullets. A numbered list gets answered by number, and a position
    // is a worse thing to be handed than the text: it means nothing on its own, it has to be resolved
    // against exactly the list that was sent, and getting that resolution wrong silently deletes the
    // wrong item. The text says what it means and matches whatever it matches.
    return [
        `A moment ago this scene held:`,
        ...offered,
        ``,
        `Look at the image now and report only what has changed.`,
        `Write anything new as a short phrase of at most ${MAX_WORDS} words.`,
        `Put remove in front of anything above that is no longer true.`,
        `Do not repeat anything above that is still true.`,
        `If nothing has changed, write: nothing`,
        ``,
        `Write everything on one line separated by | and write nothing else.`,
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

/** Which pinned phrases the scene currently holds, as an exact match on the wording asked for. */
export function matchInterests(state: string[], interests: string[]): string[] {
    return interests.filter(interest => state.includes(interest));
}
