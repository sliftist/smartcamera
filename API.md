# The actions API

`actions.ts` asks a fixed set of questions about every frame from one camera and records the answers.
It serves them on port 8772, bound to every interface so it can be read from a phone. Nothing is
authenticated, so keep it on the local network.

## The questions

Every round asks about the same fixed list and gets back the words of whatever is true. That is the
whole design. It replaced asking the model to describe the scene and report what changed, which
produced text nobody could act on: the wording drifted every round so the same fact never looked the
same twice, and it periodically deleted its own description and started over.

Closed questions do not have that problem. An answer means the same thing today as it did an hour
ago, a change is a flip rather than a rewording, and the reply is a few tokens no matter how much is
going on in the room. The thing you configured is also exactly the thing that comes back out, since
an answer is reported as the phrase you typed rather than as the word the model said.

    GET    /questions                                        -> { watches, phrases, defaults }
    POST   /questions {"phrase":"is eating pizza (pizza)"}     add
    DELETE /questions?phrase=...                              remove

A phrase carries its own word, in parentheses at the end:

    is eating pizza (pizza)

The word is what the model answers with, and choosing it is the caller's job, because the caller is
the one who finds out it was the wrong word. One string rather than a question and a keyword side by
side: the word has to be visible wherever the phrase is, so keeping it inside means every place that
shows a phrase already shows it, and there is one identity to pass around instead of a pair to keep
together. That whole string is what an entry, a log line and a stat all report.

A phrase arriving without a word is refused, unless it is one of the defaults below. Deriving one
from the question was the first attempt and it is quietly worse: the caller never agreed to the word,
cannot see it without asking, and finds out it clashed with another phrase only by getting answers
meant for that one. Two phrases answering to the same word is refused for the same reason.

The service is the only thing that ever takes a phrase apart, and it does it when one is added, which
is the last moment that is any use: the caller is still on the other end of a request and can be told
no. The client sends a string and reads a string back, so there is no second copy of the rule to
disagree, and no way to be refused by a version of it the service is not running.

The defaults, always asked and needing no registration. Each can also be named without its
parentheses, which is what lets anything that already watched one keep working untouched. They cannot
be removed: a DELETE naming one is accepted and changes nothing, and the page shows them filled in
with no cross. Removing one could only mean it disappears until the next restart, which is worse than
not being able to.

    is a person present (person)
    is anyone drinking (drinking)
    is a hand on the mouse (mouse)
    is anyone typing (typing)
    is anyone eating (eating)
    is anyone wearing headphones (headphones)
    is wearing shirt (shirt)
    is the door open (door)
    is well lit (lit)
    head tilted back with hands on face (tilted)
    brushing teeth with electric toothbrush (toothbrush)

The answer is the words of the true ones and nothing else, so anything left out is a no. A still room
costs about five output tokens rather than one per question, and generating was a third of a frame's
cost: this took a round from 1618ms to 1115ms.

Words rather than letters on purpose. A letter is the same one token, but the model has to hold a
lookup table in its head to use one, where "drinking" it can simply reason about. It also makes a
wrong answer legible. A stray letter tells you nothing; a stray word tells you what it thought it
saw, which is why words that were never offered are kept and shown on the row rather than dropped.

## Deliveries

One phrase is never asked of the room camera:

    package delivery at the door (delivery)

It comes from the door camera instead. Started with `--deliveries`, the service watches the clips
doorsync brings down, takes one frame a second from each new one, chooses the few frames where
somebody was actually in the hallway, and asks the model about those at 768x432. Every one of those
choices was measured against the hand labelled archive and each still finds all thirty deliveries.

The room goes first. A clip's frames are asked one at a time, each in the gap after a room round, so
the two take turns on the one model and a backlog of clips slows the room by at most half. The clip
sits on disk and can wait; the room cannot.

A delivery is a moment, not a state, so the phrase pulses: on in the round that reports it, off in
the next. A watcher sees exactly one start per delivery and nothing on reconnect. The entry carrying
it also says which clip and which frame decided it, under `delivery`. The verdict for every clip,
delivery or not, is written beside it as `<clip>.delivery.json` so a restart never judges one twice.

`yarn watchdeliveries` is the client: it subscribes to that phrase the way smartpause subscribes to
the headphones and shows a Windows balloon for each one.

## Subscribing

A websocket on the same port and path as the page. Three message shapes, all JSON:

    { "type": "init",  "entries": [...], "state": {...} }   once, on connect
    { "type": "entry", "entry": {...},   "state": {...} }   a round landed
    { "type": "state", "state": {...} }                     the questions changed

    const socket = new WebSocket("ws://10.0.0.200:8772");
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === "entry" && message.entry.added.includes("is anyone drinking (drinking)")) {
            // it just started
        }
    };

An entry:

| field | meaning |
| --- | --- |
| `at` | epoch milliseconds |
| `state` | the phrases answered yes |
| `added`, `removed` | which answers flipped since the round before |
| `unanswered` | phrases the model did not answer, which are neither yes nor no |
| `raw` | what the model literally replied |
| `promptTokens`, `outputTokens` | what it cost |
| `decodeMs`, `prefillMs`, `generateMs`, `analyzeMs` | where the time went |

`added` and `removed` are computed here by comparing against the previous round, never reported by
the model. A question it skipped keeps its last answer rather than flapping to no and back, and is
listed in `unanswered` so a caller can tell the difference between "no" and "did not say".

## The log

One file a day under `actions/`, holding only what cannot be worked out again. Each file opens with
the state the day began in and everything after it is a change:

    {"at":1788408519000,"state":["is a person present (person)","is anyone typing (typing)"]}
    {"at":1788408521269,"removed":["is a hand on the mouse (mouse)"]}
    {"at":1788408533419,"added":["is anyone typing (typing)"]}

Lines written before the word moved into the phrase say "is a person present" where these say "is a
person present (person)". Both are read as the same thing, so a stat covering the change is not split
down the middle by it. Only the defaults can be recovered that way, which is nearly all of what is
in there.

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

`watch` registers the phrase with the service if it is not already being asked, so a caller names what
it cares about and configures nothing. It registers it again after a reconnect, and again if the
phrases change underneath it. That is not belt and braces: the service can be restarted, or its
phrases edited by someone at the page, and a watch whose phrase had quietly stopped being asked would
look exactly like a thing that never happens.

The client passes the phrase through as a string and never looks inside it. Deciding whether a phrase
is acceptable is the service's job, since the service owns the list and the defaults, and a copy of
that rule here would be one that could disagree with the version actually running. A refusal, which
is nearly always a phrase with no word in parentheses, comes back through `onError`.

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
