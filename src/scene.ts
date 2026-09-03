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
const REMOVAL = /^(gone|no longer|removed|left)\s*:?\s+/i;
/**
 * Stripped off the front of an item before anything else. Bullets and numbers included, so that an
 * answer which just echoes the list back lands on the items already in the scene and changes nothing,
 * which is the harmless way for the model to ignore the instruction.
 */
const LEADING_MARKER = /^(?:[-−–—*\d.)\]]+\s*)+/;
const NOTHING = /^(nothing|no change|none|unchanged|same|nothing has changed)$/i;

export type SceneRound = {
    /** The scene after applying this round. */
    state: string[];
    added: string[];
    removed: string[];
};

export function buildPrompt(state: string[], full: boolean): string {
    if (full || state.length === 0) {
        return [
            `Describe this scene as a list of the objects in it and the actions happening.`,
            `Briefly describe each object, and say what each person is doing.`,
            `Keep each one to a short phrase of at most ${MAX_WORDS} words.`,
            ``,
            `Write them on one line separated by | and write nothing else.`,
        ].join("\n");
    }
    return [
        `A moment ago this scene held:`,
        ...state.map((item, index) => `${index + 1}. ${item}`),
        ``,
        `Look at the image now and report only what has changed.`,
        `Write anything new as a short phrase of at most ${MAX_WORDS} words.`,
        `Write "gone: " before anything numbered above that is no longer true.`,
        `Do not repeat anything numbered above that is still true.`,
        `If nothing has changed, write: nothing`,
        ``,
        `Write everything on one line separated by | and write nothing else.`,
    ].join("\n");
}

/** Lowercase and stripped of list punctuation, so the same phrase twice is one entry. */
function normalize(item: string): string {
    return item.replace(LEADING_MARKER, "").replace(/[.,;]+$/, "").trim().toLowerCase();
}

/**
 * Matched loosely on the way out. The model rarely quotes a removal back word for word, and refusing
 * to drop something because the wording drifted is how a scene fills up with things that left.
 *
 * A bare number is the list position, because a numbered list is an invitation to answer by number
 * and it takes that invitation: "gone: 6" is what it actually says about the sixth item.
 */
function findInState(item: string, state: string[]): string | undefined {
    const position = /^(\d+)\.?$/.exec(item);
    if (position) {
        return state[Number(position[1]) - 1];
    }
    const exact = state.find(candidate => candidate === item);
    if (exact) {
        return exact;
    }
    return state.find(candidate => candidate.includes(item) || item.includes(candidate));
}

export function parseRound(reply: string, state: string[], full: boolean): SceneRound {
    const added: string[] = [];
    const removed: string[] = [];
    // A full description replaces the scene rather than amending it, so nothing carries over.
    let next = full ? [] : [...state];

    for (const piece of reply.split("|")) {
        const trimmed = piece.trim();
        if (!trimmed || NOTHING.test(normalize(trimmed))) {
            continue;
        }
        if (!full && REMOVAL.test(trimmed)) {
            // Normalizing would eat a bare list number, since a leading digit is one of the bullet
            // shapes stripped off items, so a position is recognised before that runs.
            const target = trimmed.replace(REMOVAL, "").trim();
            const item = /^\d+\.?$/.test(target) ? target : normalize(target);
            const match = item && findInState(item, next);
            if (match) {
                next = next.filter(candidate => candidate !== match);
                removed.push(match);
            }
            continue;
        }
        const item = normalize(trimmed);
        // Already present means the model restated something still true, which the prompt asks it not
        // to do. Not an error and not news, so it is neither added nor counted as a change.
        if (!item || next.includes(item)) {
            continue;
        }
        next.push(item);
        added.push(item);
    }

    return { state: next.slice(-MAX_STATE), added, removed };
}
