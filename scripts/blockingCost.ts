import { resizeToFit } from "../src/overlay";
import { encodeJpeg } from "../src/jpeg";
import { RgbImage } from "../src/yolo";

/** How long the synchronous work on a frame blocks the loop that is also reading the rtsp stream. */
function time(label: string, times: number, work: () => void) {
    work();
    const startedAtMs = Date.now();
    for (let run = 0; run < times; run++) {
        work();
    }
    console.log(`  ${label.padEnd(38)} ${((Date.now() - startedAtMs) / times).toFixed(1)} ms`);
}

const source: RgbImage = {
    width: 1920,
    height: 1080,
    rgb: Buffer.alloc(1920 * 1080 * 3).map((_, index) => (index * 7) & 0xff),
};

console.log(`per call, on a 1920x1080 frame:`);
let scaled: RgbImage = source;
time("resizeToFit 1920x1080 -> 1252x704", 10, () => { scaled = resizeToFit(source, 1280, 704); });
time("encodeJpeg 1252x704", 10, () => { encodeJpeg(scaled.rgb, scaled.width, scaled.height); });
const jpeg = encodeJpeg(scaled.rgb, scaled.width, scaled.height);
time("base64 of that jpeg", 10, () => { jpeg.toString("base64"); });
time("encodeJpeg 1920x1080 (the old debug write)", 10, () => { encodeJpeg(source.rgb, source.width, source.height); });

const perFrameMs = (() => {
    const startedAtMs = Date.now();
    const image = resizeToFit(source, 1280, 704);
    encodeJpeg(image.rgb, image.width, image.height).toString("base64");
    return Date.now() - startedAtMs;
})();
// The camera runs at about 15fps, so this is how many access units pile up behind one call.
console.log(`\none /frame call blocks for about ${perFrameMs} ms`);
console.log(`at 15 fps that is ${(perFrameMs / (1000 / 15)).toFixed(1)} access units queued behind it`);
