import {
    AVMEDIA_TYPE_VIDEO,
    AV_CODEC_ID_H264,
    AV_PKT_FLAG_KEY,
    FFmpegError,
    FormatContext,
    Packet,
    Rational,
    Stream,
} from "node-av";

/** RTP carries H.264 on a 90kHz clock, and mpegts is happy to use the same one. */
const CLOCK_HZ = 90000;
/** RTP timestamps are 32 bit and wrap, so anything further back than this is a wrap, not a jump. */
const WRAP_THRESHOLD = 2 ** 31;

/**
 * Writes Annex B access units straight into an mpegts file.
 *
 * mpegts is the one container that takes Annex B as it comes off the wire, so nothing is decoded,
 * re-encoded or bitstream filtered here: the camera's own bytes land in the file.
 */
export class VideoRecorder {
    private output = new FormatContext();
    private stream: Stream | undefined;
    private packet = new Packet();
    private started = false;
    private firstTimestamp: number | undefined;
    private previousTimestamp = 0;
    private wraps = 0;
    private frames = 0;
    private bytes = 0;

    constructor(private file: string, private width: number, private height: number) { }

    get frameCount(): number {
        return this.frames;
    }

    get byteCount(): number {
        return this.bytes;
    }

    /** Duration covered by what has been written, in seconds. */
    get seconds(): number {
        if (this.firstTimestamp === undefined) {
            return 0;
        }
        return this.extend(this.previousTimestamp) / CLOCK_HZ;
    }

    async open() {
        FFmpegError.throwIfError(
            this.output.allocOutputContext2(null, "mpegts", this.file),
            "allocating the mpegts output",
        );
        const stream = this.output.newStream(null);
        // Mutated in place and never assigned back: the codecpar setter copies a fresh, empty set of
        // parameters over the stream, which leaves the muxer writing a private data stream.
        const parameters = stream.codecpar;
        parameters.codecType = AVMEDIA_TYPE_VIDEO;
        parameters.codecId = AV_CODEC_ID_H264;
        parameters.width = this.width;
        parameters.height = this.height;
        stream.timeBase = new Rational(1, CLOCK_HZ);
        this.stream = stream;

        FFmpegError.throwIfError(await this.output.openOutput(), "opening the output file");
        FFmpegError.throwIfError(await this.output.writeHeader(), "writing the mpegts header");
        this.packet.alloc();
        this.started = true;
    }

    /** Undoes the 32 bit wrap so the presentation timestamps only ever move forward. */
    private extend(timestamp: number): number {
        if (this.firstTimestamp === undefined) {
            return 0;
        }
        return this.wraps * 2 ** 32 + timestamp - this.firstTimestamp;
    }

    async write(annexB: Buffer, timestamp: number, keyframe: boolean) {
        const stream = this.stream;
        if (!this.started || !stream) {
            throw new Error(`Expected the recorder to be open before anything is written`);
        }
        if (this.firstTimestamp === undefined) {
            this.firstTimestamp = timestamp;
        } else if (timestamp < this.previousTimestamp && this.previousTimestamp - timestamp > WRAP_THRESHOLD) {
            this.wraps++;
        }
        this.previousTimestamp = timestamp;
        const pts = BigInt(Math.max(0, Math.round(this.extend(timestamp))));

        this.packet.data = annexB;
        this.packet.streamIndex = stream.index;
        this.packet.pts = pts;
        this.packet.dts = pts;
        this.packet.timeBase = new Rational(1, CLOCK_HZ);
        this.packet.flags = keyframe ? AV_PKT_FLAG_KEY : 0;
        try {
            FFmpegError.throwIfError(await this.output.interleavedWriteFrame(this.packet), "writing a frame");
        } finally {
            this.packet.unref();
        }
        this.frames++;
        this.bytes += annexB.length;
    }

    async close() {
        if (!this.started) {
            return;
        }
        this.started = false;
        // Without a trailer the file still plays, but nothing knows how long it is.
        FFmpegError.throwIfError(await this.output.writeTrailer(), "writing the mpegts trailer");
        await this.output.closeOutput();
        this.packet.free();
    }
}
