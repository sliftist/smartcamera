import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { formatDateTime } from "socket-function/src/formatting/format";
import { EyeClient, EyeEntry } from "./src/eyeClient";
import { DELIVERY_PHRASE } from "./src/questions";

/**
 * Shows a notification, with a picture, when a package is delivered at the door.
 *
 * The finding happens elsewhere: the actions service watches the door camera's clips and, when one
 * shows a delivery, pulses a phrase on for a single round and names the best frame of it. This
 * subscribes to that phrase exactly the way smartpause subscribes to the headphones, fetches that
 * frame, and puts it up as a Windows toast with the picture across the top. It is its own script
 * rather than a branch inside smartpause because the two have nothing in common beyond the client.
 */

/** The same fixed place smartpause reads from, so one file serves both. */
const PASSWORD_FILE = path.join(os.homedir(), "smartcamerapassword.txt");
const PASSWORD_POLL_MS = 5000;
/** Where fetched frames go. Windows needs a real file to show; it will not take bytes. */
const IMAGE_FOLDER = path.join(os.tmpdir(), "smartcamera-deliveries");
/**
 * Whose toasts these are. A toast has to come from something Windows knows, and a script is not
 * something Windows knows. This is the id it gives powershell itself, which is what actually runs
 * the call, so the toast shows and is filed under "Windows PowerShell" in the notification centre.
 */
const TOAST_APP_ID = `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const BALLOON_MS = 15_000;

type Delivery = { clip?: string; t?: number; frame?: string; image?: string };

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

/** Runs a powershell script handed over on stdin, so nothing in it can break out of a command line. */
function powershell(script: string): Promise<void> {
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

function xmlEscape(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A Windows 10 toast with the frame as its hero image.
 *
 * Built from the toast xml directly rather than through a module, so there is nothing to install on
 * the machine that shows it. The hero placement is the large picture across the top, which is the
 * one thing a balloon cannot do and the reason this exists.
 */
function toast(title: string, message: string, imageFile: string | undefined): Promise<void> {
    const hero = imageFile ? `<image placement="hero" src="file:///${xmlEscape(imageFile.replace(/\\/g, "/"))}"/>` : "";
    const xml = `<toast scenario="reminder"><visual><binding template="ToastGeneric">`
        + `<text>${xmlEscape(title)}</text><text>${xmlEscape(message)}</text>${hero}`
        + `</binding></visual></toast>`;
    const script = [
        `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null`,
        `[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null`,
        `$xml = New-Object Windows.Data.Xml.Dom.XmlDocument`,
        `$xml.LoadXml('${xml.replace(/'/g, "''")}')`,
        `$toast = New-Object Windows.UI.Notifications.ToastNotification $xml`,
        `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${TOAST_APP_ID}').Show($toast)`,
    ].join("\n");
    return powershell(script);
}

/** The balloon from the toaster script, kept as the fallback: no picture, but it has never failed. */
function balloon(title: string, message: string): Promise<void> {
    const escape = (text: string) => text.replace(/'/g, "''");
    return powershell([
        `Add-Type -AssemblyName System.Windows.Forms`,
        `$balloon = New-Object System.Windows.Forms.NotifyIcon`,
        `$balloon.Icon = [System.Drawing.SystemIcons]::Information`,
        `$balloon.BalloonTipTitle = '${escape(title)}'`,
        `$balloon.BalloonTipText = '${escape(message)}'`,
        `$balloon.Visible = $true`,
        `$balloon.ShowBalloonTip(${BALLOON_MS})`,
        `Start-Sleep -Milliseconds ${BALLOON_MS}`,
        `$balloon.Dispose()`,
    ].join("\n"));
}

/**
 * Fetches the delivery's best frame to a local file, or explains why not.
 *
 * Kept, not cleaned up: they are one frame per delivery, deliveries are rare, and the folder is the
 * only record on this machine of what was shown.
 */
async function fetchImage(url: string, password: string, delivery: Delivery): Promise<string | undefined> {
    if (!delivery.image) {
        return undefined;
    }
    const response = await fetch(`${url.replace(/\/+$/, "")}${delivery.image}`, {
        headers: password ? { Authorization: `Bearer ${password}` } : {},
    });
    if (!response.ok) {
        throw new Error(`the service answered ${response.status} for the frame`);
    }
    fs.mkdirSync(IMAGE_FOLDER, { recursive: true });
    const file = path.join(IMAGE_FOLDER, `${delivery.t ?? Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    return file;
}

/**
 * Says when, with the date, and names the clip.
 *
 * The first version printed only a time. The sync to the camera had been down for a day, so the
 * first thing this ever announced was a delivery from the previous morning, judged the moment its
 * clip finally arrived, and "10:25 am" read as today. A clip that arrives late is still worth
 * hearing about, but it has to say which day, and the file name is what you search for afterwards.
 */
function describe(entry: EyeEntry, delivery: Delivery): string {
    const at = delivery.t ?? entry.at;
    const when = new Date(at);
    const today = new Date().toDateString() === when.toDateString();
    const day = today ? "today" : when.toDateString();
    const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const ago = Date.now() - at;
    const late = ago > 15 * 60 * 1000 ? ` (${Math.round(ago / 60_000)} minutes ago, the clip arrived late)` : "";
    return `Package delivered at the door ${day} at ${time}${late}.${delivery.clip ? ` Clip ${delivery.clip}` : ""}`;
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
            void (async () => {
                const delivery = ((entry as EyeEntry & { delivery?: Delivery }).delivery) ?? {};
                const message = describe(entry, delivery);
                log(message);
                let image: string | undefined;
                try {
                    image = await fetchImage(url, password, delivery);
                    if (image) {
                        log(`frame saved to ${image}`);
                    }
                } catch (error) {
                    log(`could not fetch the frame, showing without it: ${(error as Error).message}`);
                }
                try {
                    await toast("Package delivery", message, image);
                } catch (error) {
                    // The toast api is the only part of this that could be missing on a given
                    // machine. The balloon has always worked, so the news still arrives.
                    log(`toast failed, falling back to a balloon: ${(error as Error).message}`);
                    await balloon("Package delivery", message).catch(inner => log(`could not show the notification: ${inner.message}`));
                }
            })();
        },
    });
}

main().catch(error => {
    console.error(`[watchdeliveries] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
