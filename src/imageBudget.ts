/**
 * How large a frame the model is shown, and therefore what a frame costs.
 *
 * Qwen3-VL charges image tokens by area, so this is the single biggest lever on latency, and it
 * trades directly against how much detail is there to see. Measured on this camera, cold:
 *
 *   1920x1080   2060 tokens   3235ms
 *   1280x704     878 tokens    996ms
 *   896x504      468 tokens    447ms
 *   640x360      240 tokens    242ms
 *
 * One place, because two would drift: the frame the model reads and the frame kept for review have
 * to be the same pixels, or an annotation is about something the model never saw.
 *
 * Runtime settable rather than a constant, since finding the right size is a thing you do by trying
 * it against the actual room rather than by reasoning about it.
 */

/**
 * The sizes worth offering, with what a frame actually cost at each when they were measured.
 *
 * Four buttons rather than a box to type in. Nothing between these is a useful distinction: the
 * numbers below are what the choice is really about, and picking 1180x640 over 1280x704 buys nothing
 * anyone could perceive. The times are measured on this camera and this card, cold, and are here to
 * be read rather than to be exact.
 */
export const PRESETS = [
    { width: 1920, height: 1080, frameMs: 3235 },
    { width: 1280, height: 704, frameMs: 996 },
    { width: 896, height: 504, frameMs: 447 },
    { width: 640, height: 360, frameMs: 242 },
];

export const MIN_EDGE = 160;
/** Above the camera's own 1920x1080 there is nothing to gain: it would be upscaling its own output. */
export const MAX_EDGE = 1920;

let width = Number(process.env.SMARTCAMERA_IMAGE_WIDTH || 1280);
let height = Number(process.env.SMARTCAMERA_IMAGE_HEIGHT || 704);

export function imageBudget(): { width: number; height: number } {
    return { width, height };
}

/** Returns what it ended up as, so a caller sees the result rather than assuming it. */
export function setImageBudget(wantedWidth: number, wantedHeight: number): { width: number; height: number } {
    if (!Number.isFinite(wantedWidth) || !Number.isFinite(wantedHeight)) {
        throw new Error(`width and height must be numbers`);
    }
    const rounded = [Math.round(wantedWidth), Math.round(wantedHeight)];
    for (const edge of rounded) {
        if (edge < MIN_EDGE || edge > MAX_EDGE) {
            throw new Error(`width and height must each be between ${MIN_EDGE} and ${MAX_EDGE}`);
        }
    }
    width = rounded[0];
    height = rounded[1];
    return imageBudget();
}
