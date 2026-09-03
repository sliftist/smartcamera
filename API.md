# The actions API

`actions.ts` watches one camera and keeps a running description of the scene. It serves that on
port 8772, bound to every interface so it can be read from a phone. Nothing is authenticated, so keep
it on the local network.

## Subscribing

A websocket on the same port and path as the page. Three message shapes, all JSON:

    { "type": "init",  "entries": [...], "state": {...} }   once, on connect
    { "type": "entry", "entry": {...},   "state": {...} }   a round landed
    { "type": "state", "state": {...} }                     the pinned phrases changed

    const socket = new WebSocket("ws://10.0.0.200:8772");
    socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === "entry" && message.entry.matched.includes("drinking")) {
            // ...
        }
    };

An entry:

| field | meaning |
| --- | --- |
| `at` | epoch milliseconds |
| `state` | everything in the scene after this round |
| `added`, `removed` | how `state` differs from the previous round |
| `matched` | which pinned phrases the scene currently holds |
| `full` | a full re-description rather than a change |
| `raw` | what the model literally replied |
| `promptTokens`, `outputTokens` | what it cost |
| `decodeMs`, `prefillMs`, `generateMs`, `analyzeMs` | where the time went |

`added` and `removed` are computed here, by comparing this scene against the last one. They are not
the model's account of what it changed, which is a different and less reliable thing.

## Phrases of interest

Pin the exact words you want to watch for, then compare strings. Without this the model says
"drinking water from a cup", then "sipping from a green cup", then "having a drink", and deciding
whether those are the same event needs a language model at the other end too.

    GET    /interests                        -> { interests, matched }
    POST   /interests  {"phrase":"drinking"} -> { interests }
    DELETE /interests?phrase=drinking        -> { interests }

    curl -X POST http://10.0.0.200:8772/interests \
      -H 'Content-Type: application/json' -d '{"phrase":"drinking"}'

A pinned phrase takes effect on the next round, about a second later. Phrases are lowercased, capped
at 60 characters and 20 at a time, and kept across restarts.

How it works matters, because it decides what the answers mean. A pinned phrase is put into the list
of scene contents handed to the model, as an ordinary item alongside everything else. The model is
already asked, every round, which items in that list are no longer true; a pinned phrase is just
another one of those. If it is not happening the model says so and the phrase is absent from that
round's `matched`.

So the model declines every pinned phrase on every round it is not happening, which costs output
tokens: a still scene with nothing pinned answers in 2, and with two phrases pinned in about 11. That
is the price of the mechanism and it is worth it.

Declining a pinned phrase is not a scene change. The phrases are taken back out before the diff is
computed, so `added` and `removed` never mention them; `matched` is the only place they appear.

Telling the model about the phrases in prose instead does not work. Asked that way it read the list
as an answer sheet and replied with nothing but the pinned phrases, and softer wordings either
invented phrases that were not there or paraphrased the ones that were.

## Reading it another way

    GET /status                     rounds, failures, the current scene, the live prompt
    GET /log?since=<ms>&limit=<n>   recent entries as json
    GET /frames                     the last 30s of frames held in memory
    GET /frames/<id>                one of them as a jpeg
    POST /annotate {"id","note"}    save a frame plus what the model missed, for training
