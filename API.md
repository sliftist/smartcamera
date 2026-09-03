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
each at most 120 characters, kept across restarts. With none configured nothing is asked at all.

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
