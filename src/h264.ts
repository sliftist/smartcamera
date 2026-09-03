import { RtpPacket } from "./rtsp";

export const NAL_TYPE_NON_IDR = 1;
export const NAL_TYPE_IDR = 5;
export const NAL_TYPE_SEI = 6;
export const NAL_TYPE_SPS = 7;
export const NAL_TYPE_PPS = 8;
export const NAL_TYPE_AUD = 9;

const NAL_TYPE_STAP_A = 24;
const NAL_TYPE_FU_A = 28;

const ANNEX_B_START_CODE = Buffer.from([0, 0, 0, 1]);

export type AccessUnit = {
    timestamp: number;
    nals: Buffer[];
};

export function nalType(nal: Buffer): number {
    return nal[0] & 0x1f;
}

export function isKeyframe(unit: AccessUnit): boolean {
    return unit.nals.some(nal => nalType(nal) === NAL_TYPE_IDR);
}

export function toAnnexB(nals: Buffer[]): Buffer {
    const pieces: Buffer[] = [];
    for (const nal of nals) {
        pieces.push(ANNEX_B_START_CODE, nal);
    }
    return Buffer.concat(pieces);
}

/**
 * Turns RTP payloads (RFC 6184) back into whole NAL units, grouped into access units.
 *
 * Access units are cut on the RTP timestamp changing rather than on the marker bit alone, because
 * some cameras omit the marker on the last packet of a frame.
 */
export class H264Depacketizer {
    private currentTimestamp: number | undefined;
    private nals: Buffer[] = [];
    private fragments: Buffer[] = [];
    private fragmentHeader: number | undefined;
    private droppedFragments = 0;
    private expectedSequenceNumber: number | undefined;

    constructor(private onAccessUnit: (unit: AccessUnit) => void) { }

    push(packet: RtpPacket) {
        if (this.expectedSequenceNumber !== undefined && packet.sequenceNumber !== this.expectedSequenceNumber) {
            // A gap makes any in-progress fragmented NAL unusable, and the frame it belongs to incomplete.
            this.fragments = [];
            this.fragmentHeader = undefined;
            this.nals = [];
        }
        this.expectedSequenceNumber = (packet.sequenceNumber + 1) & 0xffff;

        if (this.currentTimestamp !== undefined && packet.timestamp !== this.currentTimestamp) {
            this.flush();
        }
        this.currentTimestamp = packet.timestamp;

        const payload = packet.payload;
        const type = payload[0] & 0x1f;
        if (type === NAL_TYPE_FU_A) {
            this.pushFragment(payload);
        } else if (type === NAL_TYPE_STAP_A) {
            this.pushAggregated(payload);
        } else {
            this.nals.push(Buffer.from(payload));
        }

        if (packet.marker) {
            this.flush();
        }
    }

    private pushFragment(payload: Buffer) {
        if (payload.length < 2) {
            return;
        }
        const indicator = payload[0];
        const header = payload[1];
        const isStart = (header & 0x80) !== 0;
        const isEnd = (header & 0x40) !== 0;
        if (isStart) {
            this.fragments = [];
            this.fragmentHeader = (indicator & 0xe0) | (header & 0x1f);
        }
        if (this.fragmentHeader === undefined) {
            this.droppedFragments++;
            return;
        }
        this.fragments.push(Buffer.from(payload.subarray(2)));
        if (isEnd) {
            this.nals.push(Buffer.concat([Buffer.from([this.fragmentHeader]), ...this.fragments]));
            this.fragments = [];
            this.fragmentHeader = undefined;
        }
    }

    private pushAggregated(payload: Buffer) {
        let offset = 1;
        while (offset + 2 <= payload.length) {
            const size = payload.readUInt16BE(offset);
            offset += 2;
            if (offset + size > payload.length) {
                return;
            }
            this.nals.push(Buffer.from(payload.subarray(offset, offset + size)));
            offset += size;
        }
    }

    private flush() {
        if (this.nals.length === 0 || this.currentTimestamp === undefined) {
            return;
        }
        const unit: AccessUnit = { timestamp: this.currentTimestamp, nals: this.nals };
        this.nals = [];
        this.onAccessUnit(unit);
    }

    get fragmentsDropped(): number {
        return this.droppedFragments;
    }
}

/** Parses the base64 SPS/PPS carried in the SDP's sprop-parameter-sets fmtp attribute. */
export function parseParameterSets(spropParameterSets: string | undefined): Buffer[] {
    if (!spropParameterSets) {
        return [];
    }
    return spropParameterSets.split(",").filter(part => part.length > 0).map(part => Buffer.from(part, "base64"));
}

export type SpsInfo = {
    profileIdc: number;
    profileName: string;
    levelIdc: number;
    width: number;
    height: number;
    chromaFormatIdc: number;
    frameMbsOnly: boolean;
    entropyCodingNote: string;
};

const PROFILE_NAMES = new Map<number, string>([
    [66, "Baseline"],
    [77, "Main"],
    [88, "Extended"],
    [100, "High"],
    [110, "High 10"],
    [122, "High 4:2:2"],
    [244, "High 4:4:4 Predictive"],
]);

const MACROBLOCK_SIZE = 16;

class BitReader {
    private bitOffset = 0;
    constructor(private data: Buffer) { }

    readBit(): number {
        const byte = this.data[this.bitOffset >> 3];
        const bit = (byte >> (7 - (this.bitOffset & 7))) & 1;
        this.bitOffset++;
        return bit;
    }

    readBits(count: number): number {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = (value << 1) | this.readBit();
        }
        return value;
    }

    readUnsignedExpGolomb(): number {
        let leadingZeros = 0;
        while (this.readBit() === 0 && leadingZeros < 32) {
            leadingZeros++;
        }
        return (1 << leadingZeros) - 1 + this.readBits(leadingZeros);
    }

    readSignedExpGolomb(): number {
        const value = this.readUnsignedExpGolomb();
        return value & 1 ? (value + 1) >> 1 : -(value >> 1);
    }
}

/** Strips emulation prevention bytes (0x03 inserted after 0x0000) from a NAL payload. */
function removeEmulationPrevention(nal: Buffer): Buffer {
    const out: number[] = [];
    for (let i = 0; i < nal.length; i++) {
        if (i >= 2 && nal[i] === 0x03 && nal[i - 1] === 0x00 && nal[i - 2] === 0x00) {
            continue;
        }
        out.push(nal[i]);
    }
    return Buffer.from(out);
}

export function parseSps(spsNal: Buffer): SpsInfo {
    const rbsp = removeEmulationPrevention(spsNal.subarray(1));
    const reader = new BitReader(rbsp);
    const profileIdc = reader.readBits(8);
    reader.readBits(8); // constraint flags + reserved
    const levelIdc = reader.readBits(8);
    reader.readUnsignedExpGolomb(); // seq_parameter_set_id

    let chromaFormatIdc = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
        chromaFormatIdc = reader.readUnsignedExpGolomb();
        if (chromaFormatIdc === 3) {
            reader.readBit(); // separate_colour_plane_flag
        }
        reader.readUnsignedExpGolomb(); // bit_depth_luma_minus8
        reader.readUnsignedExpGolomb(); // bit_depth_chroma_minus8
        reader.readBit(); // qpprime_y_zero_transform_bypass_flag
        if (reader.readBit()) {
            const listCount = chromaFormatIdc !== 3 ? 8 : 12;
            for (let i = 0; i < listCount; i++) {
                if (reader.readBit()) {
                    skipScalingList(reader, i < 6 ? 16 : 64);
                }
            }
        }
    }

    reader.readUnsignedExpGolomb(); // log2_max_frame_num_minus4
    const pictureOrderCountType = reader.readUnsignedExpGolomb();
    if (pictureOrderCountType === 0) {
        reader.readUnsignedExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (pictureOrderCountType === 1) {
        reader.readBit(); // delta_pic_order_always_zero_flag
        reader.readSignedExpGolomb(); // offset_for_non_ref_pic
        reader.readSignedExpGolomb(); // offset_for_top_to_bottom_field
        const referenceFrameCount = reader.readUnsignedExpGolomb();
        for (let i = 0; i < referenceFrameCount; i++) {
            reader.readSignedExpGolomb();
        }
    }
    reader.readUnsignedExpGolomb(); // max_num_ref_frames
    reader.readBit(); // gaps_in_frame_num_value_allowed_flag
    const widthInMbs = reader.readUnsignedExpGolomb() + 1;
    const heightInMapUnits = reader.readUnsignedExpGolomb() + 1;
    const frameMbsOnly = reader.readBit() === 1;
    if (!frameMbsOnly) {
        reader.readBit(); // mb_adaptive_frame_field_flag
    }
    reader.readBit(); // direct_8x8_inference_flag

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (reader.readBit()) {
        cropLeft = reader.readUnsignedExpGolomb();
        cropRight = reader.readUnsignedExpGolomb();
        cropTop = reader.readUnsignedExpGolomb();
        cropBottom = reader.readUnsignedExpGolomb();
    }

    const subWidth = chromaFormatIdc === 3 ? 1 : 2;
    const subHeight = chromaFormatIdc === 1 ? 2 : 1;
    const width = widthInMbs * MACROBLOCK_SIZE - (cropLeft + cropRight) * subWidth;
    const heightInMbs = heightInMapUnits * (frameMbsOnly ? 1 : 2);
    const height = heightInMbs * MACROBLOCK_SIZE - (cropTop + cropBottom) * subHeight * (frameMbsOnly ? 1 : 2);

    return {
        profileIdc,
        profileName: PROFILE_NAMES.get(profileIdc) || `Unknown (${profileIdc})`,
        levelIdc,
        width,
        height,
        chromaFormatIdc,
        frameMbsOnly,
        entropyCodingNote: profileIdc === 66 ? "baseline (CAVLC only)" : "may use CABAC",
    };
}

function skipScalingList(reader: BitReader, size: number) {
    let lastScale = 8;
    let nextScale = 8;
    for (let i = 0; i < size; i++) {
        if (nextScale !== 0) {
            const delta = reader.readSignedExpGolomb();
            nextScale = (lastScale + delta + 256) % 256;
        }
        lastScale = nextScale === 0 ? lastScale : nextScale;
    }
}
