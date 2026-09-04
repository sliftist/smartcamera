import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { isLocalAddress } from "./src/network";
import { LABELS, readLabel, writeLabel, Label } from "./src/labels";

/**
 * A page for labelling the door clips, once.
 *
 * This is a tool for one pass over the archive by one person, and everything about it is shaped by
 * that. There are hundreds of clips and each is judged in a couple of seconds, so the whole design is
 * about not making the person wait or aim: the video is already playing, the keys are under their
 * fingers, and choosing a label saves it and moves on by itself. No save button, no forms, no
 * confirmation, nothing to click twice.
 */

const PORT = 8773;
const CLIP_ROOT = path.join(__dirname, "doorclips");
const CLIP_NAME = /_(\d+)\.mp4$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

type Clip = { day: string; file: string; t: number; bytes: number; labels: string[] };

/**
 * Every clip on disk, with whatever it has been labelled.
 *
 * Read fresh on each request for the list. The set only changes when the sync daemon adds a clip, and
 * a directory walk of a few hundred entries costs nothing next to always showing what is actually
 * there. Caching it would mean the page and the disk could disagree about what has been judged.
 */
function listClips(): Clip[] {
    const out: Clip[] = [];
    let days: string[];
    try {
        days = fs.readdirSync(CLIP_ROOT).filter(day => DAY_FOLDER.test(day)).sort();
    } catch {
        return out;
    }
    for (const day of days) {
        let files: string[];
        try {
            files = fs.readdirSync(path.join(CLIP_ROOT, day)).filter(file => CLIP_NAME.test(file)).sort();
        } catch {
            continue;
        }
        for (const file of files) {
            let bytes = 0;
            try {
                bytes = fs.statSync(path.join(CLIP_ROOT, day, file)).size;
            } catch {
                continue;
            }
            const label = readLabel(CLIP_ROOT, day, file);
            out.push({ day, file, t: Number(CLIP_NAME.exec(file)![1]), bytes, labels: label?.labels ?? [] });
        }
    }
    return out;
}

/** Refuses anything that could climb out of the clip folder, whatever it was asked for. */
function clipFile(day: string, file: string): string | undefined {
    if (!DAY_FOLDER.test(day) || !CLIP_NAME.test(file) || file.includes("/") || file.includes("..")) {
        return undefined;
    }
    const target = path.join(CLIP_ROOT, day, file);
    if (!target.startsWith(CLIP_ROOT + path.sep)) {
        return undefined;
    }
    return fs.existsSync(target) ? target : undefined;
}

/**
 * Sends a video, honouring a byte range if one was asked for.
 *
 * Not optional for video. A browser opens with a range request to read the header, and without a
 * partial response it cannot scrub, cannot show a duration, and on some builds will not play at all.
 */
function sendVideo(request: http.IncomingMessage, response: http.ServerResponse, target: string) {
    const size = fs.statSync(target).size;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (!(start >= 0 && start <= end && end < size)) {
            response.writeHead(416, { "Content-Range": `bytes */${size}` });
            response.end();
            return;
        }
        response.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Length": end - start + 1,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
        });
        fs.createReadStream(target, { start, end }).pipe(response);
        return;
    }
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(target).pipe(response);
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>door clips</title>
<style>
:root { color-scheme: dark; --line: #8886; --on: #d9822b; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 14px 16px 40px; background: #14171c; color: #e8e8e8; }
h1 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; opacity: .5; margin: 0 0 10px; font-weight: 600; }
#top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px; margin-bottom: 10px; }
#when { font-size: 17px; font-weight: 600; }
.quiet { opacity: .55; }
#bar { height: 4px; background: #8883; border-radius: 3px; overflow: hidden; margin-bottom: 12px; }
#bar div { height: 100%; background: var(--on); width: 0; transition: width .2s; }
#stage { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
video { width: min(100%, 900px); background: #000; border-radius: 8px; display: block; }
#side { flex: 1; min-width: 260px; }
.choice { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; font: inherit;
          padding: 9px 12px; margin-bottom: 7px; border: 1px solid var(--line); border-radius: 8px;
          background: none; color: inherit; cursor: pointer; }
.choice:hover { border-color: #aaa; }
.choice.on { border-color: var(--on); background: #d9822b22; color: var(--on); font-weight: 600; }
.choice .key { font-family: ui-monospace, monospace; font-size: 12px; opacity: .7; background: #8883;
               border-radius: 4px; padding: 1px 7px; min-width: 18px; text-align: center; }
.choice.sub { margin-left: 22px; width: calc(100% - 22px); }
.choice.sub .name::before { content: "\\21B3\\00a0"; opacity: .5; }
#keys { margin-top: 14px; font-size: 12px; opacity: .5; line-height: 1.9; }
#keys b { font-family: ui-monospace, monospace; background: #8883; border-radius: 4px; padding: 1px 6px; font-weight: 400; }
#nav { display: flex; gap: 8px; margin-top: 14px; }
button.plain { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px;
               background: none; color: inherit; cursor: pointer; }
button.plain:hover { border-color: #aaa; }
#done { text-align: center; padding: 60px 20px; font-size: 16px; }
#tally { margin-top: 18px; font-size: 12px; opacity: .6; }
#tally span { margin-right: 14px; white-space: nowrap; }
</style>
<h1>door clips</h1>
<div id="top">
  <span id="when">loading</span>
  <span id="count" class="quiet"></span>
  <span id="saved" class="quiet"></span>
</div>
<div id="bar"><div id="fill"></div></div>
<div id="stage">
  <video id="video" autoplay loop muted playsinline controls></video>
  <div id="side">
    <div id="choices"></div>
    <div id="nav">
      <button class="plain" id="prev">back</button>
      <button class="plain" id="skip">skip</button>
      <button class="plain" id="mode">reviewing unlabelled</button>
    </div>
    <div id="keys"></div>
    <div id="tally"></div>
  </div>
</div>
<div id="done" hidden>every clip has been labelled.</div>
<script>
const LABELS = __LABELS__;
let clips = [];
let at = 0;
let unlabelledOnly = true;

const video = document.getElementById("video");
const choicesHolder = document.getElementById("choices");
const savedNote = document.getElementById("saved");

function shown() {
    return unlabelledOnly ? clips.filter(clip => clip.labels.length === 0) : clips;
}
function current() {
    return shown()[at];
}

async function load() {
    clips = await (await fetch("/clips")).json();
    at = 0;
    render();
}

function render() {
    const list = shown();
    const clip = list[at];
    document.getElementById("done").hidden = !!clip;
    document.getElementById("stage").hidden = !clip;
    const labelled = clips.filter(item => item.labels.length > 0).length;
    document.getElementById("count").textContent = labelled + " of " + clips.length + " labelled";
    document.getElementById("fill").style.width = (clips.length ? (labelled / clips.length) * 100 : 0) + "%";
    tally();
    if (!clip) {
        document.getElementById("when").textContent = "done";
        return;
    }
    document.getElementById("when").textContent = new Date(clip.t).toLocaleString();
    // Only reload the source when the clip actually changed, so re-rendering after a keystroke does
    // not restart a video the person is still watching.
    const src = "/clip/" + clip.day + "/" + clip.file;
    if (!video.src.endsWith(src)) {
        video.src = src;
    }
    choicesHolder.replaceChildren();
    LABELS.forEach((label, index) => {
        const button = document.createElement("button");
        button.className = "choice" + (label.implies ? " sub" : "") + (clip.labels.includes(label.key) ? " on" : "");
        const key = document.createElement("span");
        key.className = "key";
        key.textContent = String(index + 1);
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = label.name;
        button.append(key, name);
        button.onclick = () => choose(label.key);
        choicesHolder.append(button);
    });
    document.getElementById("keys").innerHTML =
        "<b>1</b>&ndash;<b>" + LABELS.length + "</b> label and move on &nbsp; <b>space</b> skip"
        + " &nbsp; <b>&larr;</b> back &nbsp; <b>0</b> clear";
}

function tally() {
    const counts = new Map();
    for (const clip of clips) {
        for (const key of clip.labels) {
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    const holder = document.getElementById("tally");
    holder.replaceChildren();
    for (const label of LABELS) {
        const span = document.createElement("span");
        span.textContent = label.name + ": " + (counts.get(label.key) || 0);
        holder.append(span);
    }
}

/**
 * A label is a decision, so it saves and moves on. Toggling one off stays put, because turning
 * something off is a correction rather than a judgement and the person is still looking at it.
 */
async function choose(key) {
    const clip = current();
    if (!clip) {
        return;
    }
    const had = clip.labels.includes(key);
    let wanted = had ? clip.labels.filter(item => item !== key) : [...clip.labels, key];
    // Clearing a broader label clears anything that is a subset of it, matching the way choosing the
    // subset selects the broader one. The server applies the same rule; this is only so the page does
    // not show a state for the moment before it answers.
    if (had) {
        wanted = wanted.filter(item => {
            const label = LABELS.find(candidate => candidate.key === item);
            return !label || !label.implies || label.implies !== key;
        });
    }
    await save(clip, wanted);
    if (!had) {
        advance();
    } else {
        render();
    }
}

async function save(clip, wanted) {
    const reply = await (await fetch("/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: clip.day, file: clip.file, labels: wanted }),
    })).json();
    clip.labels = reply.labels || [];
    savedNote.textContent = "saved";
    setTimeout(() => { savedNote.textContent = ""; }, 900);
}

/**
 * In unlabelled mode the clip just judged leaves the list, so the next one takes its index and the
 * position must not move. That is the difference between labelling the queue and labelling every
 * other clip in it.
 */
function advance() {
    if (!unlabelledOnly) {
        at = Math.min(at + 1, shown().length);
    }
    if (at >= shown().length) {
        at = Math.max(0, shown().length - (shown().length ? 1 : 0));
        if (shown().length === 0) {
            at = 0;
        }
    }
    render();
}

document.getElementById("skip").onclick = () => { at = Math.min(at + 1, Math.max(0, shown().length - 1)); render(); };
document.getElementById("prev").onclick = () => { at = Math.max(0, at - 1); render(); };
document.getElementById("mode").onclick = () => {
    unlabelledOnly = !unlabelledOnly;
    document.getElementById("mode").textContent = unlabelledOnly ? "reviewing unlabelled" : "reviewing everything";
    at = 0;
    render();
};

document.addEventListener("keydown", event => {
    if (event.target.tagName === "INPUT" || event.metaKey || event.ctrlKey) {
        return;
    }
    if (event.key >= "1" && event.key <= String(LABELS.length)) {
        event.preventDefault();
        choose(LABELS[Number(event.key) - 1].key);
        return;
    }
    if (event.key === "0") {
        event.preventDefault();
        const clip = current();
        if (clip) {
            save(clip, []).then(render);
        }
        return;
    }
    if (event.key === " ") {
        event.preventDefault();
        document.getElementById("skip").click();
        return;
    }
    if (event.key === "ArrowLeft") {
        event.preventDefault();
        document.getElementById("prev").click();
    }
});

load();
</script>`;

const server = http.createServer((request, response) => {
    // The clips are video of where somebody lives, so nothing outside this network is served, whatever
    // it asks for and however the port came to be reachable.
    if (!isLocalAddress(request.socket.remoteAddress)) {
        response.writeHead(403, { "Content-Type": "text/plain" });
        response.end(`Only the local network can reach this\n`);
        return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(PAGE.replace("__LABELS__", JSON.stringify(LABELS)));
        return;
    }
    if (url.pathname === "/clips") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(listClips()));
        return;
    }
    const clip = /^\/clip\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (clip) {
        const target = clipFile(decodeURIComponent(clip[1]), decodeURIComponent(clip[2]));
        if (!target) {
            response.writeHead(404, { "Content-Type": "text/plain" });
            response.end(`No such clip\n`);
            return;
        }
        sendVideo(request, response, target);
        return;
    }
    if (url.pathname === "/label" && request.method === "POST") {
        let body = "";
        request.on("data", chunk => {
            body += chunk;
            if (body.length > 4096) {
                request.destroy();
            }
        });
        request.on("end", () => {
            try {
                const parsed = JSON.parse(body) as { day?: string; file?: string; labels?: string[] };
                if (!clipFile(String(parsed.day), String(parsed.file))) {
                    throw new Error(`No such clip`);
                }
                const saved: Label | undefined = writeLabel(CLIP_ROOT, String(parsed.day), String(parsed.file), parsed.labels ?? []);
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ labels: saved?.labels ?? [] }));
            } catch (error) {
                response.writeHead(400, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ error: (error as Error).message }));
            }
        });
        return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end(`Not found\n`);
});

server.listen(PORT, () => {
    const clips = listClips();
    const labelled = clips.filter(clip => clip.labels.length > 0).length;
    log(`labelling ${clips.length} clips, ${labelled} already done, at http://10.0.0.200:${PORT}`);
});
