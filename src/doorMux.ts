import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { Gop } from "./doorClient";

/**
 * Raw camera runs into an mp4, with no re-encode.
 *
 * The frames are already h264 exactly as the camera's hardware encoder produced them. All this does
 * is repackage: strip the parameter sets out of the stream and into the container's avcC box, put
 * four byte lengths in front of each unit instead of start codes, and write the timing. Nothing is
 * decoded, so a clip costs almost nothing to build and comes out bit identical to what was recorded.
 *
 * This is a port of the camera project's own download button, which is where the bit level details
 * came from. Plain javascript on purpose: no ffmpeg to install, nothing to shell out to.
 */

/** The camera's nominal rate. Only a fallback: real timing comes from the per frame offsets. */
const FPS = 30;

/** On disk each unit is preceded by its length as four bytes, rather than a start code. */
export function splitFramedNals(buf: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let at = 0;
    while (at + 4 <= buf.length) {
        const length = buf.readUInt32BE(at);
        at += 4;
        if (length <= 0 || at + length > buf.length) {
            break;
        }
        out.push(buf.subarray(at, at + length));
        at += length;
    }
    return out;
}

function nalKind(nal: Buffer): number {
    return nal[0] & 0x1f;
}

function lengthPrefixed(nals: Buffer[]): Uint8Array {
    let total = 0;
    for (const nal of nals) {
        total += 4 + nal.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const nal of nals) {
        out[at++] = nal.length >>> 24;
        out[at++] = (nal.length >>> 16) & 0xff;
        out[at++] = (nal.length >>> 8) & 0xff;
        out[at++] = nal.length & 0xff;
        out.set(nal, at);
        at += nal.length;
    }
    return out;
}

/** The decoder configuration box, built from the stream's own parameter sets. */
function buildAvcC(sps: Buffer, pps: Buffer): Uint8Array {
    const out = new Uint8Array(11 + sps.length + pps.length);
    let at = 0;
    out[at++] = 1;
    out[at++] = sps[1];
    out[at++] = sps[2];
    out[at++] = sps[3];
    out[at++] = 0xff;
    out[at++] = 0xe1;
    out[at++] = sps.length >>> 8;
    out[at++] = sps.length & 0xff;
    out.set(sps, at);
    at += sps.length;
    out[at++] = 1;
    out[at++] = pps.length >>> 8;
    out[at++] = pps.length & 0xff;
    out.set(pps, at);
    return out;
}

function codecFromSps(sps: Buffer | undefined): string {
    if (!sps || sps.length < 4) {
        return "avc1.4D0028";
    }
    const hex = (byte: number) => byte.toString(16).padStart(2, "0");
    return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`;
}

/** Coded size, read out of the parameter set, only to fill in the track header. */
function parseSpsDims(sps: Buffer): { width: number; height: number } {
    const rbsp: number[] = [];
    for (let i = 1; i < sps.length; i++) {
        // 00 00 03 is an escape the encoder inserts so a payload cannot look like a start code.
        if (i + 2 < sps.length && sps[i] === 0 && sps[i + 1] === 0 && sps[i + 2] === 3) {
            rbsp.push(0, 0);
            i += 2;
            continue;
        }
        rbsp.push(sps[i]);
    }
    let bit = 0;
    const u = (count: number): number => {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = (value << 1) | ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1);
            bit++;
        }
        return value;
    };
    const ue = (): number => {
        let zeros = 0;
        while (u(1) === 0 && zeros < 32) {
            zeros++;
        }
        return (1 << zeros) - 1 + u(zeros);
    };
    const se = (): number => {
        const k = ue();
        return (k & 1) ? (k + 1) >> 1 : -(k >> 1);
    };
    const skipScaling = (size: number): void => {
        let last = 8;
        let next = 8;
        for (let i = 0; i < size; i++) {
            if (next !== 0) {
                next = (last + se() + 256) % 256;
            }
            if (next !== 0) {
                last = next;
            }
        }
    };

    const profile = u(8);
    u(16);
    ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
        const chroma = ue();
        if (chroma === 3) {
            u(1);
        }
        ue();
        ue();
        u(1);
        if (u(1)) {
            const count = chroma === 3 ? 12 : 8;
            for (let i = 0; i < count; i++) {
                if (u(1)) {
                    skipScaling(i < 6 ? 16 : 64);
                }
            }
        }
    }
    ue();
    const poc = ue();
    if (poc === 0) {
        ue();
    } else if (poc === 1) {
        u(1);
        se();
        se();
        const count = ue();
        for (let i = 0; i < count; i++) {
            se();
        }
    }
    ue();
    u(1);
    const widthMbs = ue() + 1;
    const heightUnits = ue() + 1;
    const frameMbsOnly = u(1);
    if (!frameMbsOnly) {
        u(1);
    }
    u(1);
    let width = widthMbs * 16;
    let height = (2 - frameMbsOnly) * heightUnits * 16;
    if (u(1)) {
        const left = ue();
        const right = ue();
        const top = ue();
        const bottom = ue();
        width -= (left + right) * 2;
        height -= (top + bottom) * 2 * (2 - frameMbsOnly);
    }
    if (!(width > 0) || !(height > 0)) {
        return { width: 1920, height: 1080 };
    }
    return { width, height };
}

/**
 * When each frame of a run was actually taken.
 *
 * The camera drops whole frames when it is busy, so the rate moves and cannot be assumed. Each run
 * carries the real millisecond offset of every frame from its own start, and that is what is used.
 * The even spread is only for a run recorded before those offsets were written.
 */
function frameWalls(gop: Gop): number[] {
    const out: number[] = [];
    if (gop.dts && gop.dts.length >= gop.n) {
        for (let i = 0; i < gop.n; i++) {
            out.push(gop.t + gop.dts[i]);
        }
        return out;
    }
    const span = gop.e > gop.t ? gop.e - gop.t : (gop.n / FPS) * 1000;
    const step = span / Math.max(1, gop.n);
    for (let i = 0; i < gop.n; i++) {
        out.push(gop.t + i * step);
    }
    return out;
}

export type MuxedClip = { mp4: Buffer; frames: number; width: number; height: number; durationMs: number };

/**
 * One mp4 from the runs of a clip, in time order.
 *
 * Every run begins with its own parameter sets and a keyframe, so a clip can start at any run and
 * still decode. Timestamps are made relative to the first frame, so the file starts at zero however
 * far into the day it was recorded.
 */
export function muxClip(pieces: { gop: Gop; bytes: Buffer }[]): MuxedClip {
    type Sample = { key: boolean; data: Uint8Array; atUs: number };
    const samples: Sample[] = [];
    let sps: Buffer | undefined;
    let pps: Buffer | undefined;
    let firstWall = 0;

    for (const piece of pieces) {
        const nals = splitFramedNals(piece.bytes);
        if (!sps) {
            sps = nals.find(nal => nalKind(nal) === 7);
            pps = nals.find(nal => nalKind(nal) === 8);
        }
        const walls = frameWalls(piece.gop);
        if (!firstWall) {
            firstWall = walls[0] ?? piece.gop.t;
        }
        // The parameter sets go in the container, not in the stream, which is what an avc1 track
        // wants. Any supplementary data stays attached to the frame it describes.
        let extra: Buffer[] = [];
        let frame = 0;
        for (const nal of nals) {
            const kind = nalKind(nal);
            if (kind === 7 || kind === 8) {
                continue;
            }
            if (kind === 6) {
                extra.push(nal);
                continue;
            }
            if (kind !== 5 && kind !== 1) {
                continue;
            }
            const wall = walls[Math.min(frame, walls.length - 1)] ?? piece.gop.t;
            samples.push({ key: kind === 5, data: lengthPrefixed([...extra, nal]), atUs: Math.round((wall - firstWall) * 1000) });
            extra = [];
            frame++;
        }
    }

    if (!sps || !pps) {
        throw new Error(`the clip has no parameter sets, so nothing could decode it`);
    }
    if (samples.length === 0) {
        throw new Error(`the clip has no frames`);
    }

    const { width, height } = parseSpsDims(sps);
    const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: { codec: "avc", width, height, frameRate: FPS },
        fastStart: "in-memory",
    });
    const description = buildAvcC(sps, pps);
    const nominalUs = Math.round(1_000_000 / FPS);
    let previousUs = -1;
    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        // Two frames can share a millisecond once rounded, and a container will not take a timestamp
        // that failed to move, so it is nudged past the last one rather than dropped.
        const atUs = Math.max(sample.atUs, previousUs + 1);
        previousUs = atUs;
        const durationUs = i + 1 < samples.length ? Math.max(1, samples[i + 1].atUs - atUs) : nominalUs;
        muxer.addVideoChunkRaw(sample.data, sample.key ? "key" : "delta", atUs, durationUs,
            i === 0 ? { decoderConfig: { codec: codecFromSps(sps), description } } : undefined);
    }
    muxer.finalize();

    return {
        mp4: Buffer.from(muxer.target.buffer),
        frames: samples.length,
        width,
        height,
        durationMs: Math.round((previousUs + nominalUs) / 1000),
    };
}
