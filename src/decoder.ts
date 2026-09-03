import * as fs from "fs";
import * as path from "path";
import { Codec, CodecContext, FFmpegError, Frame, Packet, SoftwareScaleContext, AVPixelFormat, AV_CODEC_ID_H264, AV_PIX_FMT_RGB24, AVERROR_EAGAIN, SWS_BILINEAR } from "node-av";
import { millisecondStamp } from "./timestamps";

const RGB_BYTES_PER_PIXEL = 3;

export type DecodedFrame = {
    width: number;
    height: number;
    /** Tightly packed 8-bit RGB, top row first. */
    rgb: Buffer;
};

type Decoder = {
    codecContext: CodecContext;
    packet: Packet;
    frame: Frame;
    scaler: SoftwareScaleContext;
    /** What the scaler was configured for; it has to be rebuilt if the stream ever changes shape. */
    scalerSource: string;
};

let decoderPromise: Promise<Decoder> | undefined;
let failedFrameDirectory: string | undefined;

/** Where to keep the Annex B of keyframes that fail to decode, so the failure can be reproduced later. */
export function setFailedFrameDirectory(directory: string) {
    failedFrameDirectory = directory;
}

async function recordFailedFrame(annexB: Buffer, reason: string) {
    if (!failedFrameDirectory) {
        return;
    }
    await fs.promises.mkdir(failedFrameDirectory, { recursive: true });
    const file = path.join(failedFrameDirectory, `${millisecondStamp(Date.now())}.h264`);
    await fs.promises.writeFile(file, annexB);
    console.error(`[decode] failed keyframe (${reason}); wrote its ${annexB.length} bytes to ${file}`);
}

function loadDecoder(): Promise<Decoder> {
    if (decoderPromise) {
        return decoderPromise;
    }
    decoderPromise = (async () => {
        const startedAtMs = Date.now();
        const codec = Codec.findDecoder(AV_CODEC_ID_H264);
        if (!codec) {
            throw new Error(`This build of ffmpeg has no H.264 decoder`);
        }
        const codecContext = new CodecContext();
        codecContext.allocContext3(codec);
        FFmpegError.throwIfError(await codecContext.open2(codec, null), "opening the H.264 decoder");

        const packet = new Packet();
        packet.alloc();
        const frame = new Frame();
        frame.alloc();

        console.log(`[decode] H.264 decoder ready in ${Date.now() - startedAtMs}ms (${codec.name})`);
        return { codecContext, packet, frame, scaler: new SoftwareScaleContext(), scalerSource: "" };
    })();
    return decoderPromise;
}

/** Loads the decoder up front, so its startup cost is not charged to the first frame. */
export async function initializeDecoder(): Promise<void> {
    await loadDecoder();
}

/**
 * Decodes a single Annex B access unit (SPS + PPS + IDR slice) into RGB.
 *
 * The decoder is opened once and reused. Every access unit carries its own parameter sets and is an IDR,
 * so the decoder is flushed after each one: nothing has to survive between frames, which is what makes a
 * frame decodable on its own no matter what was lost around it.
 */
export async function decodeKeyframe(annexB: Buffer, width: number, height: number): Promise<DecodedFrame> {
    const decoder = await loadDecoder();
    const { codecContext, packet, frame } = decoder;

    try {
        packet.data = annexB;
        FFmpegError.throwIfError(await codecContext.sendPacket(packet), "sending the keyframe to the decoder");

        let received = await codecContext.receiveFrame(frame);
        if (received === AVERROR_EAGAIN) {
            // The decoder is holding the frame back for reordering, so tell it no more data is coming.
            await codecContext.sendPacket(null);
            received = await codecContext.receiveFrame(frame);
        }
        FFmpegError.throwIfError(received, "receiving the decoded frame");

        return await convertToRgb(decoder, width, height);
    } catch (error) {
        await recordFailedFrame(annexB, `${(error as Error).message ?? error}`);
        throw error;
    } finally {
        packet.unref();
        frame.unref();
        codecContext.flushBuffers();
    }
}

async function convertToRgb(decoder: Decoder, width: number, height: number): Promise<DecodedFrame> {
    const { frame, scaler } = decoder;
    const planes = frame.data;
    if (!planes) {
        throw new Error(`The decoded frame has no pixel data`);
    }
    if (frame.width !== width || frame.height !== height) {
        throw new Error(`Expected the decoder to produce ${width}x${height}, got ${frame.width}x${frame.height}`);
    }

    const source = `${frame.width}x${frame.height}:${frame.format}`;
    if (decoder.scalerSource !== source) {
        // A decoded video frame always carries a pixel format, never the sample format half of the union.
        const pixelFormat = frame.format as AVPixelFormat;
        scaler.getContext(frame.width, frame.height, pixelFormat, width, height, AV_PIX_FMT_RGB24, SWS_BILINEAR);
        decoder.scalerSource = source;
        console.log(`[decode] scaling ${source} to ${width}x${height} rgb24`);
    }

    const rgb = Buffer.alloc(width * height * RGB_BYTES_PER_PIXEL);
    await scaler.scale(planes, frame.linesize, 0, frame.height, [rgb], [width * RGB_BYTES_PER_PIXEL]);
    return { width, height, rgb };
}
