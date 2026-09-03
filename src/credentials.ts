import * as fs from "fs";

const RTSP_DEFAULT_PORT = 554;

export async function fileExists(file: string): Promise<boolean> {
    try {
        await fs.promises.stat(file);
        return true;
    } catch {
        return false;
    }
}

export type StreamTarget = {
    /** Full RTSP url including credentials. Never log this. */
    url: string;
    /** Url with the userinfo stripped, which is what RTSP requests are addressed to. */
    requestUrl: string;
    host: string;
    port: number;
    path: string;
    username: string;
    password: string;
};

const RTSP_URL_PATTERN = /rtsp:\/\/[^\s"'<>|&]+/i;
const RTSP_PARTS_PATTERN = /^rtsp:\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/]+)(?::(\d+))?(\/.*)?$/i;

/** The credentials file is the only place the camera password lives. It is read at runtime and never logged. */
export async function readStreamTarget(credentialsFile: string): Promise<StreamTarget> {
    const contents = await fs.promises.readFile(credentialsFile, "utf8");
    const urlMatch = RTSP_URL_PATTERN.exec(contents);
    if (!urlMatch) {
        throw new Error(`No rtsp:// url found in ${credentialsFile}`);
    }
    const url = urlMatch[0];
    const parts = RTSP_PARTS_PATTERN.exec(url);
    if (!parts) {
        throw new Error(`Could not parse the rtsp url found in ${credentialsFile}`);
    }
    const [, rawUsername, rawPassword, host, rawPort, rawPath] = parts;
    const port = rawPort ? parseInt(rawPort, 10) : RTSP_DEFAULT_PORT;
    const path = rawPath || "/";
    return {
        url,
        requestUrl: `rtsp://${host}:${port}${path}`,
        host,
        port,
        path,
        username: rawUsername ? decodeURIComponent(rawUsername) : "",
        password: rawPassword ? decodeURIComponent(rawPassword) : "",
    };
}

/** Safe to print: keeps the shape of the url but drops the userinfo. */
export function redactUrl(url: string): string {
    return url.replace(RTSP_PARTS_PATTERN, (full, user, pass, host, port, path) => {
        return `rtsp://${user ? "***:***@" : ""}${host}${port ? ":" + port : ""}${path || ""}`;
    });
}
