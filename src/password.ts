import * as crypto from "crypto";
import * as fs from "fs";

/**
 * An optional password on the whole service.
 *
 * Optional because this started as a page on a home network and there is no reason to make that
 * harder than it was. With no password set nothing is checked. With one set, nothing is reachable
 * without it, including the websocket, which matters because the feed is a description of a room.
 *
 * Stored as a salted hash rather than the password, since it sits in a file beside a log that gets
 * read by anything on the network with a browser.
 */

const ITERATIONS = 120_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

type Stored = { salt: string; hash: string; iterations: number };

function derive(password: string, salt: string, iterations: number): Buffer {
    return crypto.pbkdf2Sync(password, salt, iterations, KEY_LENGTH, DIGEST);
}

export function writePassword(file: string, password: string) {
    if (!password) {
        fs.rmSync(file, { force: true });
        return;
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const stored: Stored = {
        salt,
        hash: derive(password, salt, ITERATIONS).toString("hex"),
        iterations: ITERATIONS,
    };
    fs.writeFileSync(file, JSON.stringify(stored, undefined, 2), { mode: 0o600 });
}

export function readPassword(file: string): Stored | undefined {
    try {
        const stored = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
        return stored.salt && stored.hash ? stored : undefined;
    } catch {
        return undefined;
    }
}

/** Constant time, so a wrong password takes as long to reject whatever is wrong with it. */
export function passwordMatches(stored: Stored | undefined, offered: string): boolean {
    if (!stored) {
        return true;
    }
    if (!offered) {
        return false;
    }
    const expected = Buffer.from(stored.hash, "hex");
    const actual = derive(offered, stored.salt, stored.iterations || ITERATIONS);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Taken from a header when there is one and the query when there is not.
 *
 * The query is not there for convenience: a browser cannot set a header on a websocket handshake, so
 * without it the page could not authenticate at all. It means the password reaches the server log of
 * anything sitting in front of this, which on a home network is this process and nothing else.
 */
export function offeredPassword(headerValue: string | undefined, url: URL): string {
    const header = headerValue ?? "";
    const bearer = /^Bearer\s+(.*)$/i.exec(header);
    if (bearer) {
        return bearer[1].trim();
    }
    return url.searchParams.get("password") ?? "";
}
