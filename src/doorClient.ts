import * as fs from "fs";
import WebSocket from "ws";
import { encode, decode } from "cbor-x";

/**
 * A client for the door camera at mydoorcamera, which is a separate project on its own hardware.
 *
 * Its api is cbor-x over a websocket rather than http, and the certificate is self signed, so this
 * cannot be a fetch. The protocol is small enough to reimplement here: a call is {type,id,method,args}
 * and a reply is {type,id,value} or {type,id,error}. Reimplemented rather than imported because the
 * two projects share no package, and copying sixty lines beats making one depend on the other's
 * checkout being present and current.
 *
 * The camera is a pi doing hardware encode on every frame, so it has nothing spare. Everything here
 * is deliberately one request at a time.
 */

/** Where the camera lives. Its server binds every interface on this port. */
export const DOOR_HOST = "10.0.0.189";
export const DOOR_PORT = 8443;
/**
 * How long to wait for a reply before giving up on the connection.
 *
 * Not optional. The camera can stop part way through sending one, and a half delivered websocket
 * frame never completes, so without this the wait is forever: the socket stays established, nothing
 * is in flight, and the process sits in the event loop looking perfectly healthy. That is exactly
 * what happened, and it is the worst shape of failure for something meant to run unattended.
 *
 * Generous, because nothing here is in a hurry and a loaded camera is slow rather than broken.
 */
const CALL_TIMEOUT_MS = 60 * 1000;

/**
 * An activity clip, as the camera records it: start, end, the peak frame's time, and how much
 * movement that peak had, from 0 to 1.
 *
 * The camera writes one of these only once the clip has ended, after three seconds of stillness, so
 * anything that arrives is already complete and will never be rewritten. That is what makes this
 * safe to treat as a permanent record and classify exactly once.
 */
export type Section = { s: number; e: number; t: number; a: number };

/** One encoded run of frames. l === 0 means a static span holding no video bytes at all. */
export type Gop = {
    t: number; e: number; f: string; o: number; l: number; n: number;
    a: number; aMax: number; dts?: Uint16Array; noChange?: boolean;
};

export type HourIndex = { gops: Gop[]; badRanges: { start: number; end: number }[] };

type Packet = { type: string; id: number; method?: string; args?: unknown[]; value?: unknown; error?: { message: string } };

export class DoorClient {
    private socket: WebSocket | undefined;
    private pending = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    }>();
    private nextId = 1;

    constructor(private password: string, private host = DOOR_HOST, private port = DOOR_PORT) {}

    async connect(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            // The camera generates its own certificate, so there is no authority to check it against.
            // The password is what actually authenticates, and this only ever talks to one address on
            // the local network.
            const socket = new WebSocket(`wss://${this.host}:${this.port}`, { rejectUnauthorized: false });
            socket.binaryType = "nodebuffer";
            socket.on("open", () => resolve());
            socket.on("error", error => {
                this.fail(error as Error);
                reject(error);
            });
            socket.on("close", () => this.fail(new Error(`the camera closed the connection`)));
            socket.on("message", data => this.receive(data as Buffer));
            this.socket = socket;
        });
        await this.call("login", this.password);
    }

    close() {
        const socket = this.socket;
        this.socket = undefined;
        socket?.close();
    }

    call<T>(method: string, ...args: unknown[]): Promise<T> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error(`not connected to the camera`));
        }
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                // The socket is torn down rather than just this call abandoned. A reply that stopped
                // half way leaves the framing mid message, so nothing arriving after it can be
                // trusted to line up with the call it claims to answer. Reconnecting is the only
                // honest recovery, and the caller retries.
                this.pending.delete(id);
                reject(new Error(`the camera did not answer ${method} within ${CALL_TIMEOUT_MS / 1000}s`));
                this.close();
                this.fail(new Error(`the connection was dropped after ${method} timed out`));
            }, CALL_TIMEOUT_MS);
            this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
            socket.send(encode({ type: "call", id, method, args }));
        });
    }

    private receive(data: Buffer) {
        let packet: Packet;
        try {
            packet = decode(data) as Packet;
        } catch {
            return;
        }
        // The camera can call back into a client, for live video and index pushes. Nothing here asks
        // for either, so anything incoming is answered with an error rather than left hanging.
        if (packet.type === "call") {
            this.socket?.send(encode({ type: "result", id: packet.id, error: { message: `not handled` } }));
            return;
        }
        if (packet.type !== "result") {
            return;
        }
        const waiting = this.pending.get(packet.id);
        if (!waiting) {
            return;
        }
        this.pending.delete(packet.id);
        clearTimeout(waiting.timer);
        if (packet.error) {
            waiting.reject(new Error(packet.error.message));
        } else {
            waiting.resolve(packet.value);
        }
    }

    private fail(error: Error) {
        for (const [id, waiting] of [...this.pending]) {
            this.pending.delete(id);
            clearTimeout(waiting.timer);
            waiting.reject(error);
        }
    }

    /** Days that have footage, as "YYYY/MM/DD". */
    availableDays(): Promise<string[]> {
        return this.call<string[]>("getAvailableDays");
    }

    /**
     * The activity clips overlapping a span.
     *
     * Cheap on the camera: one small text file per day, one line per clip. This is the only thing
     * that should be polled, and the camera's own notes are emphatic that rebuilding clips from the
     * per frame index instead would be far heavier.
     */
    sections(fromMs: number, toMs: number): Promise<Section[]> {
        return this.call<Section[]>("getActivitySections", fromMs, toMs);
    }

    /** Every encoded run in one hour. Takes four path parts, hour included. */
    hourIndex(day: string[], hour: string): Promise<HourIndex> {
        return this.call<HourIndex>("getHourIndex", [...day, hour]);
    }

    /**
     * The bytes of one run.
     *
     * Three path parts, no hour, unlike the index call above. The hour is part of the file name
     * rather than a folder, so passing four here looks for a directory that does not exist.
     */
    gopData(day: string[], file: string, offset: number, length: number): Promise<Buffer> {
        return this.call<Buffer>("getGopData", day, file, offset, length);
    }
}

/**
 * Where the camera password is expected, matching how smartpause reads its own.
 *
 * The camera normalises what it is sent, keeping only letters and lowercasing them, so spaces,
 * capitals and stray punctuation in this file do not matter and nothing needs cleaning up here.
 */
export const DOOR_PASSWORD_FILE = "/root/mydoorcamera.txt";
export const PASSWORD_POLL_MS = 5000;

/** Waits for the password file, saying where it is looking each time rather than failing quietly. */
export async function readDoorPassword(log: (message: string) => void): Promise<string> {
    while (true) {
        try {
            const text = fs.readFileSync(DOOR_PASSWORD_FILE, "utf8").trim();
            if (text) {
                return text;
            }
        } catch {
            // Falls through to the same wait as an empty file.
        }
        log(`waiting for the camera password; expecting it at ${DOOR_PASSWORD_FILE}`);
        await new Promise(resolve => setTimeout(resolve, PASSWORD_POLL_MS));
    }
}
