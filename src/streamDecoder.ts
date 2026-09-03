import {
    Codec,
    CodecContext,
    FFmpegError,
    Frame,
    Packet,
    SoftwareScaleContext,
    AVPixelFormat,
    AV_CODEC_ID_H264,
    AV_PIX_FMT_RGB24,
    AVERROR_EAGAIN,
    AVERROR_EOF,
    SWS_BILINEAR,
} from "node-av";
import { DecodedFrame } from "./decoder";

const RGB_BYTES_PER_PIXEL = 3;

/**
 * Decodes a continuous H.264 stream, keeping the decoder's state between access units.
 *
 * This is the opposite of decodeKeyframe, which flushes after every frame so each keyframe stands on
 * its own. Here the state is exactly what makes P frames decodable, so nothing may be dropped between
 * a keyframe and the frames that reference it. Losing one means waiting for the next keyframe.
 */
export class StreamDecoder {
    private codecContext = new CodecContext();
    private packet = new Packet();
    private frame = new Frame();
    private scaler = new SoftwareScaleContext();
    private scalerSource = "";
    private open = false;

    async start() {
        const codec = Codec.findDecoder(AV_CODEC_ID_H264);
        if (!codec) {
            throw new Error(`This build of ffmpeg has no H.264 decoder`);
        }
        this.codecContext.allocContext3(codec);
        FFmpegError.throwIfError(await this.codecContext.open2(codec, null), "opening the H.264 decoder");
        this.packet.alloc();
        this.frame.alloc();
        this.open = true;
    }

    /** Throws away everything the decoder is holding, so the next keyframe starts clean. */
    reset() {
        if (this.open) {
            this.codecContext.flushBuffers();
        }
    }

    /** Every picture that came out of this access unit, usually one and sometimes none. */
    async decode(annexB: Buffer, width: number, height: number): Promise<DecodedFrame[]> {
        if (!this.open) {
            throw new Error(`Expected the decoder to be started before anything is decoded`);
        }
        this.packet.data = annexB;
        const sent = await this.codecContext.sendPacket(this.packet);
        this.packet.unref();
        FFmpegError.throwIfError(sent, "sending an access unit to the decoder");

        const frames: DecodedFrame[] = [];
        while (true) {
            const received = await this.codecContext.receiveFrame(this.frame);
            if (received === AVERROR_EAGAIN || received === AVERROR_EOF) {
                break;
            }
            FFmpegError.throwIfError(received, "receiving a decoded frame");
            try {
                frames.push(await this.toRgb(width, height));
            } finally {
                this.frame.unref();
            }
        }
        return frames;
    }

    private async toRgb(width: number, height: number): Promise<DecodedFrame> {
        const planes = this.frame.data;
        if (!planes) {
            throw new Error(`The decoded frame has no pixel data`);
        }
        const source = `${this.frame.width}x${this.frame.height}:${this.frame.format}`;
        if (this.scalerSource !== source) {
            const pixelFormat = this.frame.format as AVPixelFormat;
            this.scaler.getContext(this.frame.width, this.frame.height, pixelFormat, width, height, AV_PIX_FMT_RGB24, SWS_BILINEAR);
            this.scalerSource = source;
        }
        const rgb = Buffer.alloc(width * height * RGB_BYTES_PER_PIXEL);
        await this.scaler.scale(planes, this.frame.linesize, 0, this.frame.height, [rgb], [width * RGB_BYTES_PER_PIXEL]);
        return { width, height, rgb };
    }

    close() {
        if (!this.open) {
            return;
        }
        this.open = false;
        this.packet.free();
        this.frame.free();
        this.codecContext.freeContext();
    }
}
