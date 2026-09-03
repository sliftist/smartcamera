import * as net from "net";
import * as crypto from "crypto";
import { StreamTarget } from "./credentials";

const CONNECT_TIMEOUT_MS = 10 * 1000;
const RESPONSE_TIMEOUT_MS = 15 * 1000;
const KEEPALIVE_FRACTION = 0.5;
const DEFAULT_SESSION_TIMEOUT_SECONDS = 60;
const USER_AGENT = "smartcamera";

// RTSP interleaves binary RTP inside the control connection: '$' <channel> <2-byte length> <payload>.
const INTERLEAVED_MAGIC = 0x24;
const INTERLEAVED_HEADER_BYTES = 4;

const NS_PER_MS = 1e6;

const RTSP_PREFIX = "RTSP/";
const RESYNC_PREVIEW_BYTES = 48;
const RESYNC_FRAMES_TO_CONFIRM = 3;
const RESYNC_SEARCH_LIMIT_BYTES = 512 * 1024;
const MAX_PLAUSIBLE_CHANNEL = 3;

const RTP_HEADER_BYTES = 12;
const RTP_VERSION = 2;

export type RtspResponse = {
    statusCode: number;
    statusText: string;
    headers: Map<string, string>;
    body: string;
};

export type MediaDescription = {
    /** e.g. "video" or "audio" */
    kind: string;
    payloadType: number;
    /** e.g. "H264", "H265", "PCMU" */
    encoding: string;
    clockRate: number;
    control: string;
    fmtp: Map<string, string>;
};

export type RtpPacket = {
    channel: number;
    payloadType: number;
    marker: boolean;
    sequenceNumber: number;
    timestamp: number;
    payload: Buffer;
};

export class RtspClient {
    private socket: net.Socket | undefined;
    private buffer = Buffer.alloc(0);
    private textScanOffset = 0;
    private lastConsumed = "the connection handshake";

    public resyncCount = 0;
    public bytesDiscardedResyncing = 0;
    private cseq = 0;
    private sessionId: string | undefined;
    private sessionTimeoutSeconds = DEFAULT_SESSION_TIMEOUT_SECONDS;
    private keepaliveTimer: NodeJS.Timeout | undefined;
    private authorization: ((method: string, url: string) => string) | undefined;
    private pendingResponse: ((response: RtspResponse) => void) | undefined;
    private fatalError: ((error: Error) => void) | undefined;
    private closed = false;

    public onRtpPacket: ((packet: RtpPacket) => void) | undefined;
    /** When set, takes over from onRtpPacket and receives payloads before any RTP parsing happens. */
    public onInterleavedPacket: ((channel: number, payload: Buffer) => void) | undefined;

    public bytesReceived = 0;
    public chunksReceived = 0;
    public dataHandlerMs = 0;

    constructor(private target: StreamTarget) { }

    async connect(): Promise<void> {
        const socket = net.connect({ host: this.target.host, port: this.target.port });
        socket.setNoDelay(true);
        this.socket = socket;
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out connecting to ${this.target.host}:${this.target.port}`)), CONNECT_TIMEOUT_MS);
            socket.once("connect", () => {
                clearTimeout(timer);
                resolve();
            });
            socket.once("error", error => {
                clearTimeout(timer);
                reject(error);
            });
        });
        socket.on("data", (data: Buffer) => {
            const startedAtNs = process.hrtime.bigint();
            this.bytesReceived += data.length;
            this.chunksReceived++;
            this.onData(data);
            this.dataHandlerMs += Number(process.hrtime.bigint() - startedAtNs) / NS_PER_MS;
        });
        socket.on("error", error => this.onSocketFailure(error));
        socket.on("close", () => this.onSocketFailure(new Error("RTSP connection closed by the server")));
        console.log(`[rtsp] connected to ${this.target.host}:${this.target.port}`);
    }

    private onSocketFailure(error: Error) {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.stopKeepalive();
        const fatal = this.fatalError;
        if (fatal) {
            fatal(error);
        } else {
            console.error(`[rtsp] connection failure:`, error.stack ?? error);
        }
    }

    /** Rejects if the connection dies at any point, so long-running reads do not hang. */
    connectionLost(): Promise<never> {
        return new Promise<never>((_resolve, reject) => {
            this.fatalError = reject;
        });
    }

    private onData(data: Buffer) {
        this.buffer = this.buffer.length === 0 ? data : Buffer.concat([this.buffer, data]);
        while (true) {
            if (this.buffer.length === 0) {
                return;
            }
            if (this.buffer[0] === INTERLEAVED_MAGIC) {
                if (this.buffer.length < INTERLEAVED_HEADER_BYTES) {
                    return;
                }
                const channel = this.buffer[1];
                const length = this.buffer.readUInt16BE(2);
                if (this.buffer.length < INTERLEAVED_HEADER_BYTES + length) {
                    return;
                }
                const payload = this.buffer.subarray(INTERLEAVED_HEADER_BYTES, INTERLEAVED_HEADER_BYTES + length);
                this.buffer = this.buffer.subarray(INTERLEAVED_HEADER_BYTES + length);
                this.lastConsumed = `interleaved channel ${channel}, ${length} bytes`;
                this.handleInterleaved(channel, payload);
                continue;
            }
            if (!this.looksLikeRtspMessage()) {
                if (!this.resync()) {
                    return;
                }
                continue;
            }
            const headerEnd = this.buffer.indexOf("\r\n\r\n", this.textScanOffset);
            if (headerEnd < 0) {
                // Rescanning from scratch on every chunk would be quadratic while a message is still arriving.
                this.textScanOffset = Math.max(0, this.buffer.length - 3);
                return;
            }
            this.textScanOffset = 0;
            const headerText = this.buffer.subarray(0, headerEnd).toString("utf8");
            const response = parseResponseHead(headerText);
            const contentLength = parseInt(response.headers.get("content-length") || "0", 10);
            const totalLength = headerEnd + 4 + contentLength;
            if (this.buffer.length < totalLength) {
                return;
            }
            response.body = this.buffer.subarray(headerEnd + 4, totalLength).toString("utf8");
            this.buffer = this.buffer.subarray(totalLength);
            this.lastConsumed = `RTSP message ${JSON.stringify(headerText.split("\r\n")[0])}, ${contentLength} byte body`;
            const pending = this.pendingResponse;
            this.pendingResponse = undefined;
            if (pending) {
                pending(response);
            } else {
                console.error(`[rtsp] unsolicited RTSP message with no request outstanding: ${JSON.stringify(headerText.split("\r\n")[0])}, ${contentLength} byte body`);
            }
        }
    }

    private looksLikeRtspMessage(): boolean {
        if (this.buffer.length < RTSP_PREFIX.length) {
            // Too early to tell, so wait for more rather than resyncing past the start of a real message.
            return true;
        }
        return this.buffer.subarray(0, RTSP_PREFIX.length).toString("latin1") === RTSP_PREFIX;
    }

    /**
     * Recovers the interleaved framing after the byte stream stops lining up with it, which this camera
     * does occasionally. Without this the connection is dead but silent: every later byte piles up behind
     * the bytes we can no longer interpret.
     */
    private resync(): boolean {
        const start = this.buffer.length;
        for (let offset = 1; offset < this.buffer.length; offset++) {
            if (this.buffer[offset] !== INTERLEAVED_MAGIC || !this.isPlausibleFrameStart(offset)) {
                continue;
            }
            this.resyncCount++;
            this.bytesDiscardedResyncing += offset;
            console.error(`[rtsp] lost framing sync after ${this.lastConsumed}; discarded ${offset} bytes to resync (resync ${this.resyncCount}), discarded head was ${JSON.stringify(this.buffer.subarray(0, Math.min(offset, RESYNC_PREVIEW_BYTES)).toString("latin1"))}`);
            this.buffer = this.buffer.subarray(offset);
            this.textScanOffset = 0;
            return true;
        }
        // No candidate yet, so keep everything except a possible partial prefix and wait for more data.
        this.textScanOffset = 0;
        if (start > RESYNC_SEARCH_LIMIT_BYTES) {
            this.buffer = this.buffer.subarray(start - 1);
            this.bytesDiscardedResyncing += start - 1;
        }
        return false;
    }

    /** Checks a candidate '$' by walking the frame lengths that follow it, as far as the buffer allows. */
    private isPlausibleFrameStart(offset: number): boolean {
        let position = offset;
        for (let frame = 0; frame < RESYNC_FRAMES_TO_CONFIRM; frame++) {
            if (position + INTERLEAVED_HEADER_BYTES > this.buffer.length) {
                return frame > 0;
            }
            if (this.buffer[position] !== INTERLEAVED_MAGIC) {
                return false;
            }
            if (this.buffer[position + 1] > MAX_PLAUSIBLE_CHANNEL) {
                return false;
            }
            position += INTERLEAVED_HEADER_BYTES + this.buffer.readUInt16BE(position + 2);
        }
        return true;
    }

    private handleInterleaved(channel: number, payload: Buffer) {
        const rawHandler = this.onInterleavedPacket;
        if (rawHandler) {
            rawHandler(channel, payload);
            return;
        }
        const handler = this.onRtpPacket;
        if (!handler) {
            return;
        }
        const packet = parseRtpPacket(channel, payload);
        if (!packet) {
            return;
        }
        handler(packet);
    }

    async request(method: string, url: string, headers: Map<string, string> = new Map()): Promise<RtspResponse> {
        let response = await this.sendOnce(method, url, headers);
        if (response.statusCode === 401) {
            const challenge = response.headers.get("www-authenticate");
            if (!challenge) {
                return response;
            }
            this.authorization = buildAuthorizer(challenge, this.target.username, this.target.password);
            response = await this.sendOnce(method, url, headers);
        }
        return response;
    }

    private sendOnce(method: string, url: string, headers: Map<string, string>): Promise<RtspResponse> {
        const socket = this.socket;
        if (!socket) {
            throw new Error(`RTSP client is not connected`);
        }
        this.cseq++;
        const lines = [`${method} ${url} RTSP/1.0`, `CSeq: ${this.cseq}`, `User-Agent: ${USER_AGENT}`];
        if (this.sessionId) {
            lines.push(`Session: ${this.sessionId}`);
        }
        if (this.authorization) {
            lines.push(`Authorization: ${this.authorization(method, url)}`);
        }
        for (const [key, value] of headers) {
            lines.push(`${key}: ${value}`);
        }
        const request = lines.join("\r\n") + "\r\n\r\n";
        return new Promise<RtspResponse>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`Timed out waiting for the ${method} response`)), RESPONSE_TIMEOUT_MS);
            this.pendingResponse = response => {
                clearTimeout(timer);
                resolve(response);
            };
            socket.write(request, error => {
                if (error) {
                    clearTimeout(timer);
                    reject(error);
                }
            });
        });
    }

    async describe(): Promise<MediaDescription[]> {
        const headers = new Map([["Accept", "application/sdp"]]);
        const response = await this.request("DESCRIBE", this.target.requestUrl, headers);
        if (response.statusCode !== 200) {
            throw new Error(`DESCRIBE failed: ${response.statusCode} ${response.statusText}`);
        }
        const contentBase = response.headers.get("content-base") || response.headers.get("content-location") || this.target.requestUrl;
        const media = parseSdp(response.body, contentBase);
        for (const track of media) {
            console.log(`[rtsp] track ${track.kind}: ${track.encoding} payload=${track.payloadType} clock=${track.clockRate}`);
        }
        return media;
    }

    async setupInterleaved(track: MediaDescription, channel: number): Promise<void> {
        const headers = new Map([["Transport", `RTP/AVP/TCP;unicast;interleaved=${channel}-${channel + 1}`]]);
        const response = await this.request("SETUP", track.control, headers);
        if (response.statusCode !== 200) {
            throw new Error(`SETUP failed: ${response.statusCode} ${response.statusText}`);
        }
        const session = response.headers.get("session");
        if (!session) {
            throw new Error(`SETUP response had no Session header`);
        }
        const [id, ...sessionParams] = session.split(";").map(part => part.trim());
        this.sessionId = id;
        for (const param of sessionParams) {
            const [key, value] = param.split("=");
            if (key.toLowerCase() === "timeout" && value) {
                this.sessionTimeoutSeconds = parseInt(value, 10);
            }
        }
        console.log(`[rtsp] session ${this.sessionId} established on interleaved channel ${channel}, timeout ${this.sessionTimeoutSeconds}s`);
    }

    async play(): Promise<void> {
        const headers = new Map([["Range", "npt=0.000-"]]);
        const response = await this.request("PLAY", this.target.requestUrl, headers);
        if (response.statusCode !== 200) {
            throw new Error(`PLAY failed: ${response.statusCode} ${response.statusText}`);
        }
        console.log(`[rtsp] playing`);
        this.startKeepalive();
    }

    private startKeepalive() {
        const intervalMs = this.sessionTimeoutSeconds * KEEPALIVE_FRACTION * 1000;
        this.keepaliveTimer = setInterval(() => {
            this.request("OPTIONS", this.target.requestUrl).catch(error => {
                console.error(`[rtsp] keepalive failed:`, (error as Error).stack ?? error);
            });
        }, intervalMs);
    }

    private stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = undefined;
        }
    }

    async close(): Promise<void> {
        this.stopKeepalive();
        const socket = this.socket;
        if (!socket) {
            return;
        }
        if (this.sessionId && !this.closed) {
            try {
                await this.request("TEARDOWN", this.target.requestUrl);
            } catch {
                // The server frequently just drops the connection instead of answering TEARDOWN.
            }
        }
        this.closed = true;
        this.socket = undefined;
        socket.destroy();
        console.log(`[rtsp] closed`);
    }
}

function parseResponseHead(text: string): RtspResponse {
    const lines = text.split("\r\n");
    const statusLine = lines[0] || "";
    const statusMatch = /^RTSP\/\d\.\d (\d+) ?(.*)$/.exec(statusLine);
    const headers = new Map<string, string>();
    for (const line of lines.slice(1)) {
        const separator = line.indexOf(":");
        if (separator < 0) {
            continue;
        }
        headers.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
    }
    return {
        statusCode: statusMatch ? parseInt(statusMatch[1], 10) : 0,
        statusText: statusMatch ? statusMatch[2] : statusLine,
        headers,
        body: "",
    };
}

function buildAuthorizer(challenge: string, username: string, password: string): (method: string, url: string) => string {
    const scheme = challenge.split(/\s+/)[0].toLowerCase();
    if (scheme === "basic") {
        console.log(`[rtsp] authenticating with basic auth`);
        const token = Buffer.from(`${username}:${password}`).toString("base64");
        return () => `Basic ${token}`;
    }
    if (scheme !== "digest") {
        throw new Error(`Unsupported RTSP authentication scheme: ${scheme}`);
    }
    const params = new Map<string, string>();
    for (const match of challenge.slice(scheme.length).matchAll(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*([^,\s]+)/g)) {
        const key = (match[1] || match[3]).toLowerCase();
        params.set(key, match[2] !== undefined ? match[2] : match[4]);
    }
    const realm = params.get("realm") || "";
    const nonce = params.get("nonce") || "";
    const opaque = params.get("opaque");
    const qop = (params.get("qop") || "").split(",").map(part => part.trim()).includes("auth") ? "auth" : undefined;
    const ha1 = md5(`${username}:${realm}:${password}`);
    let nonceCount = 0;
    console.log(`[rtsp] authenticating with digest auth (realm ${JSON.stringify(realm)}, qop ${qop ?? "none"})`);
    return (method, url) => {
        const ha2 = md5(`${method}:${url}`);
        const fields = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${url}"`];
        let response: string;
        if (qop) {
            nonceCount++;
            const nc = nonceCount.toString(16).padStart(8, "0");
            const cnonce = crypto.randomBytes(8).toString("hex");
            response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
            fields.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
        } else {
            response = md5(`${ha1}:${nonce}:${ha2}`);
        }
        fields.push(`response="${response}"`);
        if (opaque !== undefined) {
            fields.push(`opaque="${opaque}"`);
        }
        return `Digest ${fields.join(", ")}`;
    };
}

function md5(value: string): string {
    return crypto.createHash("md5").update(value).digest("hex");
}

export function parseSdp(sdp: string, contentBase: string): MediaDescription[] {
    const media: MediaDescription[] = [];
    let current: MediaDescription | undefined;
    for (const rawLine of sdp.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("m=")) {
            const [kind, , , firstFormat] = line.slice(2).split(/\s+/);
            current = {
                kind,
                payloadType: parseInt(firstFormat, 10),
                encoding: "",
                clockRate: 0,
                control: contentBase,
                fmtp: new Map(),
            };
            media.push(current);
            continue;
        }
        if (!current || !line.startsWith("a=")) {
            continue;
        }
        const attribute = line.slice(2);
        if (attribute.startsWith("control:")) {
            current.control = resolveControl(contentBase, attribute.slice("control:".length).trim());
        } else if (attribute.startsWith("rtpmap:")) {
            const match = /^rtpmap:(\d+)\s+([^/]+)\/(\d+)/.exec(attribute);
            if (match && parseInt(match[1], 10) === current.payloadType) {
                current.encoding = match[2].toUpperCase();
                current.clockRate = parseInt(match[3], 10);
            }
        } else if (attribute.startsWith("fmtp:")) {
            const match = /^fmtp:(\d+)\s+(.*)$/.exec(attribute);
            if (match && parseInt(match[1], 10) === current.payloadType) {
                for (const param of match[2].split(";")) {
                    const separator = param.indexOf("=");
                    if (separator < 0) {
                        continue;
                    }
                    current.fmtp.set(param.slice(0, separator).trim().toLowerCase(), param.slice(separator + 1).trim());
                }
            }
        }
    }
    return media;
}

function resolveControl(contentBase: string, control: string): string {
    if (control === "*") {
        return contentBase;
    }
    if (/^rtsps?:\/\//i.test(control)) {
        return control;
    }
    return contentBase.replace(/\/+$/, "") + "/" + control.replace(/^\/+/, "");
}

export function parseRtpPacket(channel: number, data: Buffer): RtpPacket | undefined {
    if (data.length < RTP_HEADER_BYTES) {
        return undefined;
    }
    const version = data[0] >> 6;
    if (version !== RTP_VERSION) {
        return undefined;
    }
    const hasPadding = (data[0] & 0x20) !== 0;
    const hasExtension = (data[0] & 0x10) !== 0;
    const csrcCount = data[0] & 0x0f;
    let offset = RTP_HEADER_BYTES + csrcCount * 4;
    if (hasExtension) {
        if (data.length < offset + 4) {
            return undefined;
        }
        offset += 4 + data.readUInt16BE(offset + 2) * 4;
    }
    let end = data.length;
    if (hasPadding && end > offset) {
        end -= data[end - 1];
    }
    if (end <= offset) {
        return undefined;
    }
    return {
        channel,
        payloadType: data[1] & 0x7f,
        marker: (data[1] & 0x80) !== 0,
        sequenceNumber: data.readUInt16BE(2),
        timestamp: data.readUInt32BE(4),
        payload: data.subarray(offset, end),
    };
}
