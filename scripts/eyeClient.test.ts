import { EyeClient } from "../src/eyeClient";

/**
 * Drives the real service rather than a mock, because everything worth testing here is about how it
 * behaves against the real one: whether the phrases it needs get registered, whether it reconnects,
 * and whether a password is actually enforced.
 */

const URL_BASE = process.env.EYE_URL || "http://127.0.0.1:8772";
const PASSWORD = process.env.EYE_PASSWORD || "";
const WATCHED = "is there a test question in the scene (testquestion)";

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
    if (!ok) {
        failures++;
    }
    console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok || !detail ? "" : `\n         ${detail}`}`);
}

function headers(): Record<string, string> {
    return PASSWORD
        ? { "Content-Type": "application/json", Authorization: `Bearer ${PASSWORD}` }
        : { "Content-Type": "application/json" };
}

async function phrases(): Promise<string[]> {
    const response = await fetch(`${URL_BASE}/questions`, { headers: headers() });
    return ((await response.json()) as { phrases?: string[] }).phrases ?? [];
}

/** Polls an ordinary or async condition until it holds, or gives up. */
async function waitFor(condition: () => boolean | Promise<boolean>, within: number): Promise<boolean> {
    const deadline = Date.now() + within;
    while (Date.now() < deadline) {
        if (await condition()) {
            return true;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return await condition();
}

async function main() {
    console.log(`against ${URL_BASE}${PASSWORD ? " with a password" : " with no password"}:`);

    // Node has had WebSocket and fetch as globals since 22, which is what lets one file serve both.
    check("this runtime has the globals the client needs",
        typeof WebSocket !== "undefined" && typeof fetch !== "undefined");

    await fetch(`${URL_BASE}/questions?phrase=${encodeURIComponent(WATCHED)}`,
        { method: "DELETE", headers: headers() });
    check("the watched phrase is not being asked yet", !(await phrases()).includes(WATCHED));

    let connected = false;
    const errors: string[] = [];
    const client = new EyeClient({
        url: URL_BASE,
        password: PASSWORD || undefined,
        onConnectionChange: is => { connected = is; },
        onError: error => errors.push(error.message),
    });

    check("connects", await waitFor(() => connected, 10_000), errors.join("; "));

    let started = 0;
    let stopped = 0;
    const unwatch = client.watch(WATCHED, {
        onStart: () => { started++; },
        onStop: () => { stopped++; },
    });

    // The point of the registration: a caller names a question and does not have to configure it.
    check("watching registers the question with the service",
        await waitFor(async () => (await phrases()).includes(WATCHED), 8000));

    // And the recovery: someone removes it at the page, or the service restarts with an older file.
    await fetch(`${URL_BASE}/questions?phrase=${encodeURIComponent(WATCHED)}`,
        { method: "DELETE", headers: headers() });
    check("it is put back after being removed underneath us",
        await waitFor(async () => (await phrases()).includes(WATCHED), 8000));

    check("no start or stop fired for a question nobody answered yes", started === 0 && stopped === 0,
        `started ${started}, stopped ${stopped}`);

    unwatch();
    check("unwatching leaves the client running", true);

    client.close();
    await fetch(`${URL_BASE}/questions?phrase=${encodeURIComponent(WATCHED)}`,
        { method: "DELETE", headers: headers() });

    console.log(failures === 0 ? `\nall passed` : `\n${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
}

main().catch(error => {
    console.error(`[client test] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
