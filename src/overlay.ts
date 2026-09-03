import { Detection, RgbImage } from "./yolo";

const BOX_THICKNESS = 4;

// Cycled by class id, so two different classes in the same frame are usually told apart by colour.
const BOX_COLORS = [
    [255, 64, 64],
    [64, 200, 255],
    [120, 255, 64],
    [255, 200, 40],
    [220, 100, 255],
    [255, 130, 40],
    [80, 255, 200],
    [255, 255, 255],
];

/**
 * Turns the image the right way up, in place, for a camera mounted upside down. Flipping about both
 * axes is a 180 degree rotation, which is what the physical mounting does; flipping about one axis
 * would leave the result mirrored.
 */
export function rotate180(image: RgbImage) {
    const rgb = image.rgb;
    let front = 0;
    let back = image.width * image.height - 1;
    while (front < back) {
        for (let channel = 0; channel < 3; channel++) {
            const value = rgb[front * 3 + channel];
            rgb[front * 3 + channel] = rgb[back * 3 + channel];
            rgb[back * 3 + channel] = value;
        }
        front++;
        back--;
    }
}

/** A region of the frame to keep, as percentages of its width and height. */
export type CropRegion = {
    xStart: number;
    xEnd: number;
    yStart: number;
    yEnd: number;
};

const PERCENT = 100;

export function cropImage(image: RgbImage, region: CropRegion): RgbImage {
    const left = Math.round(image.width * region.xStart / PERCENT);
    const right = Math.round(image.width * region.xEnd / PERCENT);
    const top = Math.round(image.height * region.yStart / PERCENT);
    const bottom = Math.round(image.height * region.yEnd / PERCENT);
    const width = right - left;
    const height = bottom - top;
    if (width < 1 || height < 1) {
        throw new Error(`Cropping ${image.width}x${image.height} to ${region.xStart}-${region.xEnd}%, ${region.yStart}-${region.yEnd}% leaves ${width}x${height}, which has no pixels`);
    }

    const sourceStride = image.width * 3;
    const targetStride = width * 3;
    const rgb = Buffer.alloc(targetStride * height);
    for (let y = 0; y < height; y++) {
        const sourceStart = (top + y) * sourceStride + left * 3;
        image.rgb.copy(rgb, y * targetStride, sourceStart, sourceStart + targetStride);
    }
    return { width, height, rgb };
}

/** Returns a copy of the image with a rectangle drawn around each detection. */
export function drawDetections(image: RgbImage, detections: Detection[]): RgbImage {
    const rgb = Buffer.from(image.rgb);

    function setPixel(x: number, y: number, color: number[]) {
        if (x < 0 || y < 0 || x >= image.width || y >= image.height) {
            return;
        }
        const offset = (y * image.width + x) * 3;
        rgb[offset] = color[0];
        rgb[offset + 1] = color[1];
        rgb[offset + 2] = color[2];
    }

    for (const detection of detections) {
        const color = BOX_COLORS[detection.classId % BOX_COLORS.length];
        const left = Math.round(detection.x);
        const top = Math.round(detection.y);
        const right = Math.round(detection.x + detection.width);
        const bottom = Math.round(detection.y + detection.height);
        for (let thickness = 0; thickness < BOX_THICKNESS; thickness++) {
            for (let x = left; x <= right; x++) {
                setPixel(x, top + thickness, color);
                setPixel(x, bottom - thickness, color);
            }
            for (let y = top; y <= bottom; y++) {
                setPixel(left + thickness, y, color);
                setPixel(right - thickness, y, color);
            }
        }
    }

    return { width: image.width, height: image.height, rgb };
}

/**
 * Box averages the image down to fit inside the given bounds, keeping its aspect ratio, and returns
 * it unchanged when it already fits. The vision encoder charges tokens by area, so handing it a
 * 1920x1080 frame costs several times what the same scene costs at a sane size for no more detail
 * than the camera's own optics resolve. Averaging rather than sampling matters because a nearest
 * neighbour shrink of this ratio aliases thin things, and thin things here are limbs and door frames.
 */
export function resizeToFit(image: RgbImage, maxWidth: number, maxHeight: number): RgbImage {
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    if (scale >= 1) {
        return image;
    }
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));
    const rgb = Buffer.alloc(width * height * 3);
    const sourceStride = image.width * 3;
    for (let y = 0; y < height; y++) {
        // Source rows and columns are split at exact boundaries so every input pixel lands in exactly
        // one output pixel, which is what keeps the average unweighted and the brightness stable.
        const topSource = Math.floor(y * image.height / height);
        const bottomSource = Math.max(topSource + 1, Math.floor((y + 1) * image.height / height));
        for (let x = 0; x < width; x++) {
            const leftSource = Math.floor(x * image.width / width);
            const rightSource = Math.max(leftSource + 1, Math.floor((x + 1) * image.width / width));
            let red = 0;
            let green = 0;
            let blue = 0;
            for (let sourceY = topSource; sourceY < bottomSource; sourceY++) {
                const row = sourceY * sourceStride;
                for (let sourceX = leftSource; sourceX < rightSource; sourceX++) {
                    const offset = row + sourceX * 3;
                    red += image.rgb[offset];
                    green += image.rgb[offset + 1];
                    blue += image.rgb[offset + 2];
                }
            }
            const count = (bottomSource - topSource) * (rightSource - leftSource);
            const target = (y * width + x) * 3;
            rgb[target] = Math.round(red / count);
            rgb[target + 1] = Math.round(green / count);
            rgb[target + 2] = Math.round(blue / count);
        }
    }
    return { width, height, rgb };
}
