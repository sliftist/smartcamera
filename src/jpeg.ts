import { encode } from "jpeg-js";

const JPEG_QUALITY = 80;
const RGBA_BYTES_PER_PIXEL = 4;

/** Encodes tightly packed 8-bit RGB as a JPEG. */
export function encodeJpeg(rgb: Buffer, width: number, height: number): Buffer {
    const rgba = Buffer.alloc(width * height * RGBA_BYTES_PER_PIXEL);
    for (let pixel = 0; pixel < width * height; pixel++) {
        rgba[pixel * 4] = rgb[pixel * 3];
        rgba[pixel * 4 + 1] = rgb[pixel * 3 + 1];
        rgba[pixel * 4 + 2] = rgb[pixel * 3 + 2];
        rgba[pixel * 4 + 3] = 255;
    }
    return encode({ data: rgba, width, height }, JPEG_QUALITY).data;
}
