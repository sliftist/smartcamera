import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { formatDateTime } from "socket-function/src/formatting/format";
import { EyeClient, EyeEntry } from "./src/eyeClient";
import { DELIVERY_PHRASE } from "./src/questions";

/**
 * Shows a notification when a package is delivered at the door.
 *
 * The finding happens elsewhere: the actions service watches the door camera's clips and, when one
 * shows a delivery, pulses a phrase on for a single round. This subscribes to that phrase exactly
 * the way smartpause subscribes to the headphones, and turns each start into a Windows balloon. It
 * is its own script rather than a branch inside smartpause because the two have nothing in common
 * beyond the client, and either should be runnable without the other.
 */

/** The same fixed place smartpause reads from, so one file serves both. */
const PASSWORD_FILE = path.join(os.homedir(), "smartcamerapassword.txt");
const PASSWORD_POLL_MS = 5000;
/** How long the balloon stays. Long enough to be noticed from across the room, short enough not to nag. */
const BALLOON_MS = 15_000;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

async function readPassword(): Promise<string> {
    while (true) {
        try {
            return fs.readFileSync(PASSWORD_FILE, "utf8").replace(/\r?\n$/, "");
        } catch {
            log(`waiting for the password; expecting it at ${PASSWORD_FILE}`);
            await new Promise(resolve => setTimeout(resolve, PASSWORD_POLL_MS));
        }
    }
}

/**
 * A Windows balloon, through powershell.
 *
 * Borrowed from the toaster script in the smart repo, which is the one thing here known to reliably
 * put a notification on this desktop. The script is handed to powershell on stdin rather than on
 * the command line, so a title with a quote in it cannot break out of anything.
 */
function notify(title: string, message: string): Promise<void> {
    const escape = (text: string) => text.replace(/'/g, "''");
    const script = [
        `Add-Type -AssemblyName System.Windows.Forms`,
        `$balloon = New-Object System.Windows.Forms.NotifyIcon`,
        `$balloon.Icon = [System.Drawing.SystemIcons]::Information`,
        `$balloon.BalloonTipTitle = '${escape(title)}'`,
        `$balloon.BalloonTipText = '${escape(message)}'`,
        `$balloon.Visible = $true`,
        `$balloon.ShowBalloonTip(${BALLOON_MS})`,
        `Start-Sleep -Milliseconds ${BALLOON_MS}`,
        `$balloon.Dispose()`,
    ].join("\n");
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "-"],
            { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", chunk => {
            stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", code => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`powershell exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
            }
        });
        child.stdin.end(script);
    });
}

function describe(entry: EyeEntry): string {
    const clip = (entry as EyeEntry & { delivery?: { clip?: string; t?: number } }).delivery;
    const when = clip?.t ? formatDateTime(clip.t) : formatDateTime(entry.at);
    return `A package was delivered at the door at ${when}.`;
}

function urlFrom(argv: string[]): string {
    const flag = argv.indexOf("--url");
    if (flag >= 0 && argv[flag + 1]) {
        return argv[flag + 1];
    }
    return process.env.EYE_URL || "http://127.0.0.1:8772";
}

async function main() {
    const url = urlFrom(process.argv.slice(2));
    const password = await readPassword();
    log(`watching ${JSON.stringify(DELIVERY_PHRASE)} at ${url}`);

    new EyeClient({
        url,
        password,
        onConnectionChange: (connected, reason) =>
            log(connected ? `connected` : `disconnected${reason ? `: ${reason}` : ""}, retrying`),
        onError: error => log(`${error.message}`),
    }).watch(DELIVERY_PHRASE, {
        onStart: entry => {
            const message = describe(entry);
            log(message);
            notify("Package delivery", message).catch(error => log(`could not show the notification: ${error.message}`));
        },
    });
}

main().catch(error => {
    console.error(`[watchdeliveries] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
