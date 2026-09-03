/**
 * A fixed questionnaire, asked of every frame, answered a letter at a time.
 *
 * This replaces asking the model to describe the scene and report what changed. That produced text
 * nobody could act on: the wording drifted every round so the same fact never looked the same twice,
 * and it periodically deleted its own description and started over. Neither is fixable by parsing
 * harder, because the output was open ended and an open ended answer is a different answer each time.
 *
 * Questions are closed. Every round asks exactly the same ones and gets back yes or no for each, so
 * an answer means the same thing today as it did an hour ago, a change is a flip rather than a
 * rewording, and the whole reply is a few tokens regardless of how much is going on in the room.
 */

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Each question costs prompt and output tokens on every round, so the list has a ceiling. */
export const MAX_QUESTIONS = 26;
export const MAX_QUESTION_LENGTH = 120;
/** A letter, then yes or no, however the model chooses to punctuate it. */
const ANSWER = /\b([A-Z])\s*[):.\-=]?\s*(yes|no|y|n|true|false)\b/gi;

export function letterFor(index: number): string {
    return LETTERS[index] ?? "?";
}

export function normalizeQuestion(question: string): string {
    return question.replace(/\s+/g, " ").trim();
}

export function buildPrompt(questions: string[]): string {
    return [
        `Answer each question about this image.`,
        ``,
        ...questions.map((question, index) => `${letterFor(index)} ${question}`),
        ``,
        `Reply with each letter followed by yes or no, on one line, and nothing else.`,
        `Like this: ${questions.map((_, index) => `${letterFor(index)} ${index % 2 === 0 ? "yes" : "no"}`).join(" ")}`,
    ].join("\n");
}

/**
 * The questions answered yes.
 *
 * Read by scanning for letter-then-answer pairs anywhere in the reply rather than by expecting a
 * shape, because the model punctuates it differently round to round and a strict reader would throw
 * away good answers over a comma. A question the model did not answer is not a no: it is left out,
 * and the caller sees it neither appear nor leave.
 */
export function parseAnswers(reply: string, questions: string[]): { yes: string[]; answered: string[] } {
    const yes: string[] = [];
    const answered: string[] = [];
    ANSWER.lastIndex = 0;
    let match = ANSWER.exec(reply);
    while (match) {
        const index = LETTERS.indexOf(match[1].toUpperCase());
        const question = index >= 0 ? questions[index] : undefined;
        if (question && !answered.includes(question)) {
            answered.push(question);
            if (/^(yes|y|true)$/i.test(match[2])) {
                yes.push(question);
            }
        }
        match = ANSWER.exec(reply);
    }
    // Reported in the order they were asked, so two rounds are comparable by eye.
    return {
        yes: questions.filter(question => yes.includes(question)),
        answered: questions.filter(question => answered.includes(question)),
    };
}

/** What changed, by comparing two answer sets rather than by asking the model what changed. */
export function diffAnswers(before: string[], after: string[]): { added: string[]; removed: string[] } {
    return {
        added: after.filter(question => !before.includes(question)),
        removed: before.filter(question => !after.includes(question)),
    };
}
