import { formatDateTime } from "socket-function/src/formatting/format";
import { fileExists, readStreamTarget, redactUrl } from "./src/credentials";
import { outputDirectory } from "./src/paths";
import { LoggedFrame, watchDetections } from "./src/detectionLog";
import { pausePlayingMedia, resumeMedia } from "./src/media";

const PAUSE_AFTER_MISSING_FRAMES = 3;
const RESUME_AFTER_PRESENT_FRAMES = 3;
const PERSON_CLASS = "person";

function printHelp() {
    console.log(`
Watches the detection log written by "yarn smart" and pauses media when you leave.

  yarn autopause <credentials file>

The credentials file is the same one given to "yarn smart"; it only supplies the address, which is how
the right output folder is found. Nothing connects to the camera here.

${PAUSE_AFTER_MISSING_FRAMES} frames without a person pauses whatever is playing, and ${RESUME_AFTER_PRESENT_FRAMES} frames with a person resumes exactly what
was paused. Nothing is paused unless it was playing, and nothing is resumed unless we paused it.
`.trim());
}

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

class Watcher {
    private missingRun = 0;
    private presentRun = 0;
    /** Non empty exactly when we are the reason something is paused. */
    private pausedSessions: string[] = [];

    async onFrame(frame: LoggedFrame) {
        const present = frame.detections.some(detection => detection.className === PERSON_CLASS);
        this.missingRun = present ? 0 : this.missingRun + 1;
        this.presentRun = present ? this.presentRun + 1 : 0;

        if (this.pausedSessions.length > 0) {
            if (this.presentRun < RESUME_AFTER_PRESENT_FRAMES) {
                return;
            }
            const result = await resumeMedia(this.pausedSessions);
            const skipped = result.skipped.length > 0 ? `, left ${result.skipped.join(", ")} alone because something else changed it` : "";
            log(`playing: person back for ${this.presentRun} frames, resumed ${result.changed.join(", ") || "nothing"}${skipped}`);
            this.pausedSessions = [];
            return;
        }

        // Only on the frame the run reaches the limit: staying away must not mean asking Windows about
        // its media sessions every couple of seconds forever.
        if (this.missingRun !== PAUSE_AFTER_MISSING_FRAMES) {
            return;
        }
        const result = await pausePlayingMedia();
        if (result.changed.length === 0) {
            log(`nothing to pause: no person for ${this.missingRun} frames, and nothing was playing`);
            return;
        }
        this.pausedSessions = result.changed;
        log(`paused: no person for ${this.missingRun} frames, paused ${result.changed.join(", ")}`);
    }
}

async function main() {
    const credentialsFile = process.argv[2];
    if (!credentialsFile || !await fileExists(credentialsFile)) {
        printHelp();
        process.exit(0);
    }

    const target = await readStreamTarget(credentialsFile);
    const directory = outputDirectory(target);
    console.log(`[autopause] ${redactUrl(target.url)}, reading detections from ${directory}`);

    const watcher = new Watcher();
    for await (const frame of watchDetections(directory)) {
        await watcher.onFrame(frame);
    }
}

main().catch(error => {
    console.error(`[autopause] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
