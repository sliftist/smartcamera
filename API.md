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

Pin the exact words you want to watch for, then look for them in `state`, `added` and `removed` like
anything else. Without this the model says "drinking water from a cup", then "sipping from a green
cup", then "having a drink", and deciding whether those are the same event needs a language model at
the other end too.

    GET    /interests                        -> { interests, matched }
    POST   /interests  {"phrase":"drinking"} -> { interests }
    DELETE /interests?phrase=drinking        -> { interests }

    curl -X POST http://10.0.0.200:8772/interests \
      -H 'Content-Type: application/json' -d '{"phrase":"drinking"}'

A pinned phrase takes effect on the next round, about a second later. Phrases are lowercased, capped
at 60 characters and 20 at a time, and kept across restarts.

Nothing downstream can tell a pinned phrase from anything else the model said. It appears in `state`,
and appearing and leaving show up in `added` and `removed`, exactly as if the model had described it
itself. That is the point: a caller pins the wording so it can compare strings, and then works with
one scene rather than two lists.

How it works is an implementation detail, but a load bearing one. The phrases are lettered and asked
as their own question, separate from the scene, and the model answers with the letters that are true.
The letters are expanded back to their phrases here and folded into the scene before anything leaves.

Two other ways were tried first. Telling the model about the phrases in prose does not work: it read
the list as an answer sheet and replied with nothing but the pinned phrases, and softer wordings
either invented phrases that were not there or paraphrased the ones that were. Slipping them into the
scene list as ordinary items does not work either: the model never integrated them, spent most of
every reply declining the same ones, and flickered on the marginal ones. Asked directly, it answers.

## Reading it another way

    GET /status                     rounds, failures, the current scene, the live prompt
    GET /log?since=<ms>&limit=<n>   recent entries as json
    GET /frames                     the last 30s of frames held in memory
    GET /frames/<id>                one of them as a jpeg
    POST /annotate {"id","note"}    save a frame plus what the model missed, for training
