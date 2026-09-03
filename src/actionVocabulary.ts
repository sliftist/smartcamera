/**
 * The vocabulary trick.
 *
 * Asking what is happening in a scene is open ended, and an open ended answer is a sentence, which is
 * expensive to generate and impossible to compare against the previous one. Almost every frame of a
 * camera holds the same handful of actions as the frame before it, so the model is asked to name the
 * repeats by letter and to spell out only what it has not been given a letter for. A quiet scene then
 * costs a couple of output tokens, and the moment something genuinely new happens the answer widens
 * to describe it. The log ends up as a list of actions rather than a pile of prose, and the letters
 * never reach it: they are resolved back to their text before anything is written down.
 */

/** How many actions carry a letter. Beyond this the oldest is forgotten to keep the prompt short. */
export const DEFAULT_VOCABULARY_SIZE = 10;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ACTION_WORDS = 6;
const MIN_ACTIONS = 3;
const MAX_ACTIONS = 6;
/** A letter on its own, tolerating the punctuation a model tends to add back. */
const LETTER_PATTERN = /^([A-Z])[).:\]]?$/;
/** Leading list punctuation on a spelled out action, same tolerance. */
const LEADING_MARKER = /^(?:[-*\d.)\]]+\s*)+/;

export type ActionRound = {
    /** Every action the model reported, letters already resolved back to their text. */
    actions: string[];
    /** The ones that had no letter, which is the only part of a round that is genuinely new. */
    added: string[];
};

export function letterFor(index: number): string {
    return LETTERS[index] ?? "?";
}

/**
 * Asked plainly, the model answers a busy scene with one summarising phrase, which throws away most
 * of what is in the frame. Naming the aspects to cover and a count is what makes it enumerate instead
 * of summarise: the same frame goes from "person coding on computer" to six separate observations.
 */
export function buildPrompt(known: string[]): string {
    const lines = [
        `List each separate thing happening in this image right now.`,
        `Cover the person's posture, what their hands are doing, what they are looking at,`,
        `and anything else going on. Only list what you can actually see.`,
        `Give between ${MIN_ACTIONS} and ${MAX_ACTIONS} actions.`,
    ];
    if (known.length > 0) {
        lines.push(``, `These actions already have a letter:`);
        known.forEach((action, index) => lines.push(`${letterFor(index)}) ${action}`));
        lines.push(``, `If an action is one of those, write only its letter.`);
        lines.push(`If it is not, write it as a short phrase of at most ${MAX_ACTION_WORDS} words.`);
    } else {
        lines.push(``, `Write each action as a short phrase of at most ${MAX_ACTION_WORDS} words.`);
    }
    // Last, because the format is the instruction most often dropped when it is buried mid prompt.
    lines.push(``, `Write everything on one line separated by | and write nothing else.`);
    return lines.join("\n");
}

/** Lowercase and stripped of trailing punctuation, so the same action twice is one entry. */
function normalize(action: string): string {
    return action.replace(LEADING_MARKER, "").replace(/[.,;]+$/, "").trim().toLowerCase();
}

export function parseRound(reply: string, known: string[]): ActionRound {
    const actions: string[] = [];
    const added: string[] = [];
    for (const piece of reply.split("|")) {
        const trimmed = piece.trim();
        if (!trimmed) {
            continue;
        }
        const letter = LETTER_PATTERN.exec(trimmed.toUpperCase());
        // A letter past the end of the vocabulary means nothing, so it is dropped rather than guessed at.
        if (letter) {
            const action = known[LETTERS.indexOf(letter[1])];
            if (action && !actions.includes(action)) {
                actions.push(action);
            }
            continue;
        }
        const action = normalize(trimmed);
        if (!action || actions.includes(action)) {
            continue;
        }
        actions.push(action);
        if (!known.includes(action)) {
            added.push(action);
        }
    }
    return { actions, added };
}

/**
 * Least recently seen first, so the letter that falls off the end is the action nothing has done for
 * the longest. Seeing an action again moves it back, which is what keeps a rare but recurring action
 * from being forgotten between appearances.
 */
export function remember(known: string[], seen: string[], size = DEFAULT_VOCABULARY_SIZE): string[] {
    const kept = known.filter(action => !seen.includes(action));
    return [...kept, ...seen].slice(-size);
}
