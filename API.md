# The actions API

`actions.ts` asks a fixed set of questions about every frame from one camera and records the answers.
It serves them on port 8772, bound to every interface so it can be read from a phone. Nothing is
authenticated, so keep it on the local network.

## The questions

Every round asks the same questions and gets back yes or no for each. That is the whole design. It
replaced asking the model to describe the scene and report what changed, which produced text nobody
could act on: the wording drifted every round so the same fact never looked the same twice, and it
periodically deleted its own description and started over.

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

## Reading it another way

    GET /status                     rounds, failures, the questions, which are yes, the live prompt
    GET /log?since=<ms>&limit=<n>   recent entries as json
    GET /frames                     the last 30s of frames held in memory
    GET /frames/<id>                one of them as a jpeg
    POST /annotate {"id","note"}    save a frame plus what the model missed, for training
