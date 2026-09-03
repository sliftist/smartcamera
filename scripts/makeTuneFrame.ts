import * as fs from "fs";
import * as path from "path";
import { decode } from "jpeg-js";
import { resizeToFit } from "../src/overlay";
import { encodeJpeg } from "../src/jpeg";
import { imageBudget } from "../src/imageBudget";

/** A fixed frame at exactly the size eye2 sends, so tuning measures the real workload. */
const source = path.join(__dirname, "..", "bench-frames", "00.jpg");
const target = path.join(__dirname, "..", "bench-frames", "tune.jpg");

const raw = decode(fs.readFileSync(source), { useTArray: true });
const rgb = Buffer.alloc(raw.width * raw.height * 3);
for (let pixel = 0; pixel < raw.width * raw.height; pixel++) {
    rgb[pixel * 3] = raw.data[pixel * 4];
    rgb[pixel * 3 + 1] = raw.data[pixel * 4 + 1];
    rgb[pixel * 3 + 2] = raw.data[pixel * 4 + 2];
}
const budget = imageBudget();
const scaled = resizeToFit({ width: raw.width, height: raw.height, rgb }, budget.width, budget.height);
fs.writeFileSync(target, encodeJpeg(scaled.rgb, scaled.width, scaled.height));
console.log(`  tune frame is ${scaled.width}x${scaled.height}, exactly what eye2 sends`);
