# The actions API

`actions.ts` asks a fixed set of questions about every frame from one camera and records the answers.
It serves them on port 8772, bound to every interface so it can be read from a phone. Nothing is
authenticated, so keep it on the local network.

## The questions

Every round asks about the same phrases and gets back yes or no for each. That is the whole design.
It replaced asking the model to describe the scene and report what changed, which produced text
nobody could act on: the wording drifted every round so the same fact never looked the same twice,
and it periodically deleted its own description and started over.

A phrase is a bare phrase, not a question. "drinking" and "hand on mouse" are what you actually want
to watch for, and the model has no trouble deciding whether one is true of an image. It also means
the thing you configured is exactly the thing that comes back out, since an answer is reported as the
phrase you typed.

Closed questions do not have that problem. An answer means the same thing today as it did an hour
ago, a change is a flip rather than a rewording, and the reply is a few tokens no matter how much is
going on in the room.

    GET    /questions                                    -> { questions }
    POST   /questions  {"question":"is anyone drinking"}  -> { questions }
    DELETE /questions?question=is%20anyone%20drinking     -> { questions }

    curl -X POST http://10.0.0.200:8772/questions \
      -H 'Content-Type: application/json' -d '{"question":"is a hand on the mouse"}'

A new question is asked of the next frame, about a second later. Up to 26 of them, one per letter,
each at most 120 characters.

The list is not kept on disk. A restart goes back to the defaults below, and anything else is there
only because something asked for it and is still around to ask again. That is what stops the list
growing forever: every experiment anyone ever ran would otherwise stay in the prompt, and each entry
costs prompt and output tokens on every single frame. A client re-registers on connect anyway, so in
practice a watcher that still exists puts its question straight back, within a second of a restart.

The defaults, always asked and needing no registration. They cannot be removed: a DELETE naming one
is accepted and changes nothing, and the page shows them filled in with no cross on them. Removing
one could only mean it disappears until the next restart, which is worse than not being able to.

    is a person present
    is anyone drinking
    is a hand on the mouse
    is anyone typing
    is anyone eating
    is anyone wearing headphones
    is the door open

They are lettered on the way in and the answer comes back as letters, which is why a round costs
about 15 output tokens for seven questions. The letters never leave this process.

## Subscribing

A websocket on the same port and path as the page. Three message shapes, all JSON:

    { "type": "init",  "entries": [...], "state": {...} }   once, on connect
    { "type": "entry", "entry": {...},   "state": {...} }   a round landed
    { "type": "state", "state": {...} }                     the questions changed

    const socket = new WebSocket("ws://10.0.0.200:8772");
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === "entry" && message.entry.added.includes("is anyone drinking")) {
            // it just started
        }
    };

An entry:

| field | meaning |
| --- | --- |
| `at` | epoch milliseconds |
| `state` | the questions answered yes |
| `added`, `removed` | which answers flipped since the round before |
| `unanswered` | questions the model did not answer, which are neither yes nor no |
| `raw` | what the model literally replied |
| `promptTokens`, `outputTokens` | what it cost |
| `decodeMs`, `prefillMs`, `generateMs`, `analyzeMs` | where the time went |

`added` and `removed` are computed here by comparing against the previous round, never reported by
the model. A question it skipped keeps its last answer rather than flapping to no and back, and is
listed in `unanswered` so a caller can tell the difference between "no" and "did not say".

## The log

One file a day under `actions/`, holding only what cannot be worked out again. Each file opens with
the state the day began in and everything after it is a change:

    {"at":1788408519000,"state":["is a person present","is anyone typing"]}
    {"at":1788408521269,"removed":["is a hand on the mouse"]}
    {"at":1788408533419,"added":["is anyone typing"]}

A round where nothing flipped writes nothing at all, which is most of them. Times are plain
milliseconds since the epoch. Timings and token counts are not written: they describe the run rather
than the room, they were the bulk of a line, and nothing reads them back. A round recovered from a
file therefore has no timings, and the page leaves that column blank for it rather than showing a
confident zero.

That took a line from about 311 bytes to about 61, and stopped writing the roughly 70,000 identical
rounds a day where nothing happened.

The opening snapshot is what makes a file stand alone. Without it, replaying a day that began mid
afternoon would apply its changes to an empty scene and get the wrong answer for everything that was
already true at midnight.

## Resolution

A frame is downscaled to fit inside a budget before the model sees it, keeping the aspect ratio, so
1280x704 against a 1920x1080 camera actually sends 1252x704. It is the single biggest lever on
latency, because Qwen3-VL charges image tokens by area. Measured on this camera, cold:

    1920x1080   2060 tokens   3235ms
    1280x704     878 tokens    996ms
    896x504      468 tokens    447ms
    640x360      240 tokens    242ms

1280x704 is the default. The page offers those four as buttons, labelled with the times above,
because nothing between them is a distinction worth making and the time is what the choice is
actually about. Over http:

    GET  /resolution                      -> { width, height, presets }
    POST /resolution {"width":896,"height":504}

An api caller is not held to the presets, only to each edge being between 160 and 1920; above the
camera own output there is nothing to gain. It takes effect on the very next frame, with no restart,
which is the point: the right size is something you find by trying it against the actual room. It is
not remembered across a restart.

The same setting decides what /frames hands out, so a frame kept for review is the pixels the answer
came from rather than a sharper version the model never saw.

## Who can connect

Only the local network, checked before the password and before anything is served. The service binds
every interface so it can be read from a phone, which means a port forward or a careless router is
all that stands between it and the internet. A connection from outside 10/8, 192.168/16, 172.16/12,
169.254/16, loopback, or their ipv6 equivalents is refused whatever password it offers.

## Reading it another way

    GET /status                     rounds, failures, the questions, which are yes, the live prompt
    GET /log?since=<ms>&limit=<n>   recent entries as json
    GET /frames                     the last 30s of frames held in memory
    GET /frames/<id>                one of them as a jpeg
    POST /annotate {"id","note"}    save a frame plus what the model missed, for training

## A password

Optional. With none set nothing is checked, which is how it starts.

    yarn password              is one set?
    yarn password hunter2      set or replace it
    yarn password ""           remove it

Or from the page, which has a field for it, or over http:

    GET  /password                        -> { set }
    POST /password {"password":"hunter2"}  -> { set }
    POST /password {"password":""}         -> removes it

Changing it needs no separate proof: reaching the endpoint at all means the current one was accepted,
or that there is none. The page remembers the new one immediately, since its next request would
otherwise be refused by the password it just set.

It takes effect on the next request, with no restart. Once set, everything needs it: the page, the
json, the frames and the websocket. Send it as `Authorization: Bearer <password>`, or as a `password`
query parameter. The query parameter exists because a browser cannot put a header on a websocket
handshake, so without it the page could not connect at all.

The password is taken exactly as written, with one space after `Bearer` as the separator and nothing
trimmed. A trailing space still cannot survive a header, because HTTP lets any hop strip the optional
whitespace around a field value; the query parameter has no such rule and carries anything.

Stored as a salted PBKDF2 hash, not as the password, since the file sits beside a log that anything
on the network can otherwise read. The page remembers it in localStorage and asks again if it is
refused.

## The client library

`src/eyeClient.ts` runs unchanged in a browser and under Node. It imports nothing: `WebSocket` and
`fetch` are globals in both, on Node 22 and any current browser.

    import { EyeClient } from "./src/eyeClient";

    const client = new EyeClient({ url: "http://10.0.0.200:8772", password: "hunter2" });

    const unwatch = client.watch("is anyone drinking", {
        onStart: entry => console.log("started at", new Date(entry.at)),
        onStop: entry => console.log("stopped at", new Date(entry.at)),
    });

    // later
    unwatch();
    client.close();

`watch` registers the question with the service if it is not already being asked, so a caller names
what it cares about and configures nothing. It registers it again after a reconnect, and again if the
questions change underneath it. That is not belt and braces: the service can be restarted, or its
questions edited by someone at the page, and a watch whose question had quietly stopped being asked
would look exactly like a thing that never happens.

Reconnection is automatic, backing off from a second to a minute, because a service that is down is
usually down for more than a second and a client retrying every second forever is hard to tell from
something attacking it.

The backlog delivered on connect seeds what is currently true and fires nothing, so a reconnect does
not replay history as though it were news. `client.current()` returns everything answered yes right
now. A callback that throws is reported through `onError` and does not stop the feed.

## smartpause

Pauses whatever is playing when the headphones come off and resumes when they go back on. It used to
poll eye2 in a loop and parse yes or no out of prose; it subscribes now, because the actions service
is asking that question of every frame anyway and a second thing hammering the model with its own
copy of it was waste.

    yarn smartpause

The address is baked into that script. The password is read from a fixed path in the home folder,
beside facehuggingtoken.txt:

    ~/smartcamerapassword.txt

If it is not there, smartpause says so every five seconds and waits, naming the path each time,
rather than starting up and failing quietly. Only the trailing newline an editor adds is stripped;
anything else in the file, spaces included, is part of the password.

Both directions take effect on the first answer that says so, with nothing waiting on a second
opinion.

## History

The day files are small enough to read whole and work out anything you like from.

    GET /history?days=7   -> { days, events }   the raw lines, replayed by you
    GET /stats?days=7     -> the same, summarised per condition

A summary carries, for each condition, how long it was true, that as a fraction, and how many
separate times it happened. Plus `trackedMs`, which is the denominator, and `spanMs`, which is the
wall clock the files cover.

Those last two are different on purpose, and the difference is the point.

`trackedMs` counts only the time something was actually running. A gap longer than 150 seconds is
read as the service having been away and is left out. Without that, whatever happened to be true when
it stopped would be credited with every hour it was off, and a percentage would be a fiction. This is
also why the recorder writes a heartbeat: without a line at least once a minute, a still hour and an
hour of downtime look identical in the file.

`instances` counts occurrences, not rounds. An hour at the desk is one instance, not two thousand.
Coming back after downtime counts as a new one, which is what it looks like from here.

The page reads this once on load and shows it as a table.

## Comparing resolutions

The useful question about resolution is not how fast each size is, which is easy to measure, but what
the cheaper one stops noticing. That only shows up on real frames from the actual room.

    GET  /comparison                  -> { running, run, endsAt, rounds, deviations, higher, lower }
    POST /comparison {"enabled":true}  start comparing against the next size down
    POST /comparison {"enabled":false} stop

    GET /comparisons                          -> { runs }
    GET /comparisons/<run>                    -> { summary, deviations }
    GET /comparisons/<run>/frames/<name>      the frame a deviation happened on

While a run is going, every frame is asked twice: once at the size in use and once at the next preset
down. Both answers come from the same captured frame, which is the whole reason eye2 does the second
ask rather than the caller making a second request. Two requests would each get their own frame, and
then every disagreement would be the room having moved.

A round costs roughly double while this is on, so a run stops itself after an hour if nothing stops
it first.

Only disagreements are written. A run where the two sizes agree all afternoon leaves an empty file,
which is the answer. Each deviation records what each size said, which questions they differed on,
and the frame it happened on, kept in a `frames` folder beside the file.

A summary counts each question two ways, because the direction is what matters. A question the
smaller size keeps missing is a reason not to use it. One it keeps inventing is a different problem.

The page has a button beside the resolutions to start and stop a run, and a separate button to load
the deviations. That data is never fetched on page load: the frames are the only heavy thing here and
nobody wants last week's run pulled down on every reload.
