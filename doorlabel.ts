import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { formatDateTime } from "socket-function/src/formatting/format";
import { isLocalAddress } from "./src/network";
import { LABELS, readLabel, writeLabel, clearLabel } from "./src/labels";

/**
 * A page for labelling the door clips, once.
 *
 * This is a tool for one pass over the archive by one person, and everything about it is shaped by
 * that. There are hundreds of clips and each is judged in a couple of seconds, so the whole design is
 * about not making the person wait or aim: the video is already playing, the keys are under their
 * fingers, and answering saves it and moves on by itself.
 *
 * Reviewed and labelled are separate. Deciding that none of the labels apply is an answer, and worth
 * as much to a dataset as a positive one, so it is written down and the clip does not come back. A
 * clip only returns to the queue if the review is explicitly undone.
 */

const PORT = 8773;
const CLIP_ROOT = path.join(__dirname, "doorclips");
const CLIP_NAME = /_(\d+)\.mp4$/;
const DAY_FOLDER = /^\d{4}-\d{2}-\d{2}$/;

function log(message: string) {
    console.log(`${formatDateTime(Date.now())} | ${message}`);
}

type Clip = { day: string; file: string; t: number; bytes: number; reviewed: boolean; labels: string[] };

/**
 * Every clip on disk, with whatever it has been judged.
 *
 * Read fresh on each request for the list. The set only changes when the sync daemon adds a clip, and
 * a directory walk of a few hundred entries costs nothing next to always showing what is actually
 * there. Caching it would mean the page and the disk could disagree about what has been reviewed.
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
            out.push({
                day,
                file,
                t: Number(CLIP_NAME.exec(file)![1]),
                bytes,
                reviewed: !!label,
                labels: label?.labels ?? [],
            });
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
    // A clip is written once and never changed, so the browser is told it can keep it. That is what
    // lets going back to an earlier clip cost nothing, on top of the player that preloads forwards.
    const cache = { "Cache-Control": "private, max-age=86400, immutable" };
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
            ...cache,
        });
        fs.createReadStream(target, { start, end }).pipe(response);
        return;
    }
    response.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": size, "Accept-Ranges": "bytes", ...cache });
    fs.createReadStream(target).pipe(response);
}

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>door clips</title>
<style>
:root { color-scheme: dark; --line: #8886; --on: #d9822b; --yes: #4a9d5f; }
body { font: 14px/1.5 system-ui, sans-serif; margin: 0; padding: 14px 16px 40px; background: #14171c; color: #e8e8e8; }
h1 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; opacity: .5; margin: 0 0 10px; font-weight: 600; }
#top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px; margin-bottom: 8px; }
#when { font-size: 17px; font-weight: 600; }
#place { font-size: 17px; font-weight: 600; color: var(--on); margin-left: auto; font-variant-numeric: tabular-nums; }
.quiet { opacity: .55; }
/* Two bars, because they answer different questions. The top one is how far through the queue in
   front of you; the thin one is how much of the whole archive has ever been judged. Either alone
   left something you could not see. */
#bar { height: 9px; background: #8883; border-radius: 5px; overflow: hidden; margin-bottom: 4px; }
#bar div { height: 100%; background: var(--on); width: 0; transition: width .2s; }
#allbar { height: 4px; background: #8883; border-radius: 3px; overflow: hidden; margin-bottom: 9px; }
#allbar div { height: 100%; background: var(--yes); width: 0; transition: width .2s; }
#numbers { display: flex; flex-wrap: wrap; gap: 2px 20px; margin-bottom: 13px; font-size: 13px; }
#numbers b { font-variant-numeric: tabular-nums; font-weight: 600; }
#numbers .done b { color: var(--yes); }
#numbers .left b { color: var(--on); }
#stage { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
/* Two players stacked, one showing and one quietly loading the clip after this one. Stacked rather
   than hidden, because a player set to display none is treated as off screen and gets its loading
   deprioritised, which is the whole thing this is trying to avoid. */
.stack { position: relative; width: min(100%, 900px); }
.stack video { width: 100%; background: #000; border-radius: 8px; display: block; }
.stack video.standby { position: absolute; inset: 0; opacity: 0; pointer-events: none; }
#side { flex: 1; min-width: 270px; }
.choice { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; font: inherit;
          padding: 9px 12px; margin-bottom: 7px; border: 1px solid var(--line); border-radius: 8px;
          background: none; color: inherit; cursor: pointer; }
.choice:hover { border-color: #aaa; }
.choice.on { border-color: var(--on); background: #d9822b22; color: var(--on); font-weight: 600; }
.choice .key { font-family: ui-monospace, monospace; font-size: 12px; opacity: .7; background: #8883;
               border-radius: 4px; padding: 1px 7px; min-width: 18px; text-align: center; }
.choice.sub { margin-left: 22px; width: calc(100% - 22px); }
.choice.sub .name::before { content: "\\21B3\\00a0"; opacity: .5; }
.choice.none { border-style: dashed; margin-top: 12px; }
#state { margin-top: 12px; font-size: 13px; }
#state.seen { color: var(--yes); }
#keys { margin-top: 12px; font-size: 12px; opacity: .5; line-height: 1.9; }
#keys b { font-family: ui-monospace, monospace; background: #8883; border-radius: 4px; padding: 1px 6px; font-weight: 400; }
#nav { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
button.plain { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px;
               background: none; color: inherit; cursor: pointer; }
button.plain:hover { border-color: #aaa; }
#done { padding: 50px 20px; font-size: 16px; }
</style>
<h1>door clips</h1>
<div id="top">
  <span id="when">loading</span>
  <span id="saved" class="quiet"></span>
  <span id="place"></span>
</div>
<div id="bar"><div id="fill"></div></div>
<div id="allbar"><div id="allfill"></div></div>
<div id="numbers"></div>
<div id="stage">
  <div class="stack">
    <video id="videoA" loop muted playsinline controls preload="auto"></video>
    <video id="videoB" class="standby" loop muted playsinline controls preload="auto"></video>
  </div>
  <div id="side">
    <div id="choices"></div>
    <div id="state"></div>
    <div id="nav">
      <button class="plain" id="prev">back</button>
      <button class="plain" id="unreview">un-review</button>
      <button class="plain" id="mode">showing unreviewed</button>
    </div>
    <div id="keys"></div>
  </div>
</div>
<div id="done" hidden>every clip has been reviewed.</div>
<script>
const LABELS = __LABELS__;
let clips = [];
let at = 0;
let unreviewedOnly = true;

const choicesHolder = document.getElementById("choices");
const savedNote = document.getElementById("saved");

/**
 * Two players, one showing and one loading the clip that comes next.
 *
 * Swapped rather than reused. Pointing one player at a new file throws away everything it had
 * buffered and starts again, which is the pause you feel between clips. Handing over to a player
 * that already has the file, and already sits at the right moment in it, makes moving on immediate.
 */
const players = [document.getElementById("videoA"), document.getElementById("videoB")];
let liveAt = 0;
const live = () => players[liveAt];
const standby = () => players[1 - liveAt];

function sourceFor(clip) {
    return "/clip/" + clip.day + "/" + clip.file;
}

/**
 * Starts a clip from its middle, which is usually where whatever happened is happening.
 *
 * Done as soon as the duration is known rather than on play, so a player loading in the background
 * is already sitting at the right moment before it is ever shown. Looping still restarts from the
 * beginning, so watching a second time gives the whole clip.
 */
function toMiddle(video) {
    const seek = () => {
        if (video.duration > 0 && isFinite(video.duration)) {
            try {
                video.currentTime = video.duration / 2;
            } catch {
                // Not seekable yet. It plays from the start, which is worse but not broken.
            }
        }
    };
    if (video.readyState >= 1) {
        seek();
    } else {
        video.addEventListener("loadedmetadata", seek, { once: true });
    }
}

function point(video, clip) {
    video.src = sourceFor(clip);
    video.load();
    toMiddle(video);
}

function showClip(clip) {
    const wanted = sourceFor(clip);
    if (live().src.endsWith(wanted)) {
        // Already on screen. A re-render after a keystroke must not restart what is playing.
    } else if (standby().src.endsWith(wanted)) {
        // The one that was loading is the one wanted, so just trade places.
        live().pause();
        live().classList.add("standby");
        liveAt = 1 - liveAt;
        live().classList.remove("standby");
        live().play().catch(() => { /* a browser that will not autoplay is not worth failing over */ });
    } else {
        point(live(), clip);
        live().play().catch(() => { /* as above */ });
    }
    // Whatever is now standing by gets the clip after this one.
    const list = shown();
    const next = list[at + 1];
    if (next && !standby().src.endsWith(sourceFor(next))) {
        point(standby(), next);
        standby().pause();
    }
}

function shown() {
    return unreviewedOnly ? clips.filter(clip => !clip.reviewed) : clips;
}
function current() {
    return shown()[at];
}

/**
 * The position lives in the address bar, as the clip's own id rather than its number in the list.
 * The number moves the moment anything is reviewed; the id does not, so reloading lands on the same
 * clip and not merely the same place in a list that has since shifted underneath it.
 */
function remember() {
    const clip = current();
    const query = (clip ? "?clip=" + clip.t : "?") + (unreviewedOnly ? "" : "&all=1");
    history.replaceState(null, "", query);
}

function restore() {
    const params = new URLSearchParams(location.search);
    unreviewedOnly = params.get("all") !== "1";
    document.getElementById("mode").textContent = unreviewedOnly ? "showing unreviewed" : "showing everything";
    const wanted = Number(params.get("clip"));
    if (!wanted) {
        at = 0;
        return;
    }
    const list = shown();
    const exact = list.findIndex(clip => clip.t === wanted);
    if (exact >= 0) {
        at = exact;
        return;
    }
    // It was reviewed and has left this list, so land on the next clip in time rather than at the
    // top. Coming back to the beginning after a reload would be the single most annoying thing here.
    const after = list.findIndex(clip => clip.t > wanted);
    at = after >= 0 ? after : Math.max(0, list.length - 1);
}

async function load() {
    clips = await (await fetch("/clips")).json();
    restore();
    render();
}

function render() {
    const list = shown();
    const clip = list[at];
    document.getElementById("done").hidden = !!clip;
    document.getElementById("stage").hidden = !clip;

    const reviewed = clips.filter(item => item.reviewed).length;
    const remaining = clips.length - reviewed;
    document.getElementById("allfill").style.width = (clips.length ? (reviewed / clips.length) * 100 : 0) + "%";
    document.getElementById("fill").style.width =
        (list.length ? ((clip ? at : list.length) / list.length) * 100 : 100) + "%";
    document.getElementById("place").textContent = clip ? (at + 1) + " of " + list.length : "";

    const counts = new Map();
    for (const item of clips) {
        for (const key of item.labels) {
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    const numbers = document.getElementById("numbers");
    numbers.replaceChildren();
    const stat = (name, value, klass) => {
        const span = document.createElement("span");
        span.className = klass || "";
        span.append(name + " ");
        const b = document.createElement("b");
        b.textContent = String(value);
        span.append(b);
        numbers.append(span);
    };
    stat("reviewed", reviewed, "done");
    stat("left", remaining, "left");
    stat("total", clips.length);
    for (const label of LABELS) {
        stat(label.name, counts.get(label.key) || 0);
    }
    stat("reviewed as nothing", clips.filter(item => item.reviewed && item.labels.length === 0).length);

    remember();
    if (!clip) {
        document.getElementById("when").textContent = "done";
        return;
    }
    document.getElementById("when").textContent = new Date(clip.t).toLocaleString();
    showClip(clip);

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
    const none = document.createElement("button");
    none.className = "choice none" + (clip.reviewed && clip.labels.length === 0 ? " on" : "");
    const noneKey = document.createElement("span");
    noneKey.className = "key";
    noneKey.textContent = "space";
    const noneName = document.createElement("span");
    noneName.className = "name";
    noneName.textContent = "none of these";
    none.append(noneKey, noneName);
    none.onclick = () => nothing();
    choicesHolder.append(none);

    const state = document.getElementById("state");
    state.className = clip.reviewed ? "seen" : "quiet";
    state.textContent = clip.reviewed
        ? (clip.labels.length ? "reviewed" : "reviewed, nothing applied")
        : "not reviewed yet";
    document.getElementById("keys").innerHTML =
        "<b>1</b>&ndash;<b>" + LABELS.length + "</b> label &nbsp; <b>space</b> none of these"
        + " &nbsp; <b>&larr;</b> back &nbsp; <b>0</b> un-review";
}

/**
 * A label is a decision, so it saves and moves on. Toggling one off stays put, because turning
 * something off is a correction rather than a judgement and the clip is still on screen.
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
    if (had) {
        render();
    } else {
        advance();
    }
}

/** Nothing applied. A real answer, recorded like any other, and the clip does not come back. */
async function nothing() {
    const clip = current();
    if (!clip) {
        return;
    }
    await save(clip, []);
    advance();
}

async function save(clip, wanted) {
    const reply = await (await fetch("/label", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: clip.day, file: clip.file, labels: wanted }),
    })).json();
    clip.labels = reply.labels || [];
    clip.reviewed = true;
    savedNote.textContent = "saved";
    setTimeout(() => { savedNote.textContent = ""; }, 900);
}

/** Puts it back in the queue. The only way a reviewed clip is ever shown again. */
async function unreview() {
    const clip = current();
    if (!clip) {
        return;
    }
    await fetch("/unreview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ day: clip.day, file: clip.file }),
    });
    clip.reviewed = false;
    clip.labels = [];
    render();
}

/**
 * In unreviewed mode the clip just answered leaves the list, so the next one takes its index and the
 * position must not move. That is the difference between working through the queue and answering
 * every other clip in it.
 */
function advance() {
    const list = shown();
    if (!unreviewedOnly) {
        at = at + 1;
    }
    if (at > list.length - 1) {
        at = Math.max(0, list.length - 1);
    }
    if (list.length === 0) {
        at = 0;
    }
    render();
}

document.getElementById("prev").onclick = () => { at = Math.max(0, at - 1); render(); };
document.getElementById("unreview").onclick = () => unreview();
document.getElementById("mode").onclick = () => {
    unreviewedOnly = !unreviewedOnly;
    document.getElementById("mode").textContent = unreviewedOnly ? "showing unreviewed" : "showing everything";
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
        unreview();
        return;
    }
    if (event.key === " ") {
        event.preventDefault();
        nothing();
        return;
    }
    if (event.key === "ArrowLeft") {
        event.preventDefault();
        at = Math.max(0, at - 1);
        render();
    }
});

load();
</script>`;

function readBody(request: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = "";
        request.on("data", chunk => {
            body += chunk;
            if (body.length > 4096) {
                request.destroy();
            }
        });
        request.on("end", () => resolve(body));
        request.on("error", reject);
    });
}

const server = http.createServer(async (request, response) => {
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
    if ((url.pathname === "/label" || url.pathname === "/unreview") && request.method === "POST") {
        try {
            const parsed = JSON.parse(await readBody(request)) as { day?: string; file?: string; labels?: string[] };
            const day = String(parsed.day);
            const file = String(parsed.file);
            if (!clipFile(day, file)) {
                throw new Error(`No such clip`);
            }
            if (url.pathname === "/unreview") {
                clearLabel(CLIP_ROOT, day, file);
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({ reviewed: false, labels: [] }));
                return;
            }
            const saved = writeLabel(CLIP_ROOT, day, file, parsed.labels ?? []);
            response.writeHead(200, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ reviewed: true, labels: saved.labels }));
        } catch (error) {
            response.writeHead(400, { "Content-Type": "application/json" });
            response.end(JSON.stringify({ error: (error as Error).message }));
        }
        return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end(`Not found\n`);
});

server.listen(PORT, () => {
    const clips = listClips();
    const reviewed = clips.filter(clip => clip.reviewed).length;
    log(`${clips.length} clips, ${reviewed} reviewed, ${clips.length - reviewed} left, at http://10.0.0.200:${PORT}`);
});
