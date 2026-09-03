/**
 * A client for the actions service, for a browser or for Node.
 *
 * Nothing in here is imported, on purpose. WebSocket and fetch are globals in both places on the
 * versions this targets, so the same file runs unbundled in a page and unmodified under Node.
 *
 * What it is for is watching whether something is happening. The service answers a fixed set of
 * questions about every frame; a caller here names one and gets told when the answer turns yes and
 * when it turns no. Everything else, the connection, the reconnection, and making sure the question
 * is actually being asked, is this file's problem rather than the caller's.
 */

export type EyeEntry = {
    at: number;
    /** The questions answered yes this round. */
    state: string[];
    added: string[];
    removed: string[];
    unanswered: string[];
    raw: string;
    promptTokens: number;
    outputTokens: number;
    decodeMs: number;
    prefillMs: number;
    generateMs: number;
    analyzeMs: number;
};

export type EyeState = {
    rounds: number;
    failures: number;
    buffered: number;
    bufferSeconds: number;
    questions: string[];
    yes: string[];
    prompt: string;
};

export type WatchHandlers = {
    /** The answer just turned yes. */
    onStart?: (entry: EyeEntry) => void;
    /** The answer just turned no. */
    onStop?: (entry: EyeEntry) => void;
};

export type EyeClientOptions = {
    /** Where the service is, e.g. "http://10.0.0.200:8772". */
    url: string;
    /** Only needed if a password has been set on the service. */
    password?: string;
    /** How long to wait before reconnecting, doubling up to a minute. */
    reconnectMs?: number;
    /** Called on connect, disconnect and error, for anything that wants to show a light. */
    onConnectionChange?: (connected: boolean, reason?: string) => void;
    onError?: (error: Error) => void;
};

const DEFAULT_RECONNECT_MS = 1000;
const MAX_RECONNECT_MS = 60_000;

type Watch = {
    question: string;
    handlers: WatchHandlers;
};

export class EyeClient {
    private socket: WebSocket | undefined;
    private watches = new Set<Watch>();
    /** What the last round said was true, so a change can be told from a repeat. */
    private yes = new Set<string>();
    private closed = false;
    private reconnectMs: number;
    private retry: ReturnType<typeof setTimeout> | undefined;
    private connected = false;

    constructor(private options: EyeClientOptions) {
        this.reconnectMs = options.reconnectMs ?? DEFAULT_RECONNECT_MS;
        this.connect();
    }

    /**
     * Watch a question, and be told when it starts and stops being true.
     *
     * The question is registered with the service if it is not already being asked, so a caller does
     * not have to configure anything first, and it is registered again after a reconnect. That is not
     * belt and braces: the service can be restarted, or its questions edited by someone at the page,
     * and a watch that quietly stopped being asked would look exactly like a thing that never happens.
     */
    watch(question: string, handlers: WatchHandlers): () => void {
        const watch: Watch = { question, handlers };
        this.watches.add(watch);
        void this.ensureQuestions();
        return () => {
            this.watches.delete(watch);
        };
    }

    /** Everything currently answered yes, as of the last round. */
    current(): string[] {
        return [...this.yes];
    }

    close() {
        this.closed = true;
        if (this.retry) {
            clearTimeout(this.retry);
            this.retry = undefined;
        }
        this.socket?.close();
        this.socket = undefined;
    }

    private headers(): Record<string, string> {
        return this.options.password
            ? { "Content-Type": "application/json", Authorization: `Bearer ${this.options.password}` }
            : { "Content-Type": "application/json" };
    }

    private socketUrl(): string {
        const base = this.options.url.replace(/\/+$/, "").replace(/^http/, "ws");
        // A browser cannot set a header on a websocket handshake, so the password goes in the query.
        return this.options.password ? `${base}/?password=${encodeURIComponent(this.options.password)}` : base;
    }

    /** Adds any watched question the service is not currently asking. */
    private async ensureQuestions() {
        const wanted = [...new Set([...this.watches].map(watch => watch.question))];
        if (wanted.length === 0) {
            return;
        }
        try {
            const response = await fetch(`${this.options.url.replace(/\/+$/, "")}/questions`, { headers: this.headers() });
            if (!response.ok) {
                throw new Error(`the service answered ${response.status}`);
            }
            const asked = ((await response.json()) as { questions?: string[] }).questions ?? [];
            for (const question of wanted) {
                if (!asked.includes(question)) {
                    await fetch(`${this.options.url.replace(/\/+$/, "")}/questions`, {
                        method: "POST",
                        headers: this.headers(),
                        body: JSON.stringify({ question }),
                    });
                }
            }
        } catch (error) {
            this.options.onError?.(error as Error);
        }
    }

    private connect() {
        if (this.closed) {
            return;
        }
        let socket: WebSocket;
        try {
            socket = new WebSocket(this.socketUrl());
        } catch (error) {
            this.options.onError?.(error as Error);
            this.scheduleReconnect();
            return;
        }
        this.socket = socket;

        socket.onopen = () => {
            this.connected = true;
            this.reconnectMs = this.options.reconnectMs ?? DEFAULT_RECONNECT_MS;
            this.options.onConnectionChange?.(true);
            void this.ensureQuestions();
        };
        socket.onmessage = event => {
            try {
                this.receive(JSON.parse(String((event as MessageEvent).data)));
            } catch (error) {
                this.options.onError?.(error as Error);
            }
        };
        socket.onerror = () => {
            // The close that follows is where the reconnect is scheduled, so this only reports.
            this.options.onError?.(new Error(`the connection to ${this.options.url} failed`));
        };
        socket.onclose = event => {
            const wasConnected = this.connected;
            this.connected = false;
            this.socket = undefined;
            if (wasConnected) {
                this.options.onConnectionChange?.(false, (event as CloseEvent)?.reason || undefined);
            }
            this.scheduleReconnect();
        };
    }

    private scheduleReconnect() {
        if (this.closed || this.retry) {
            return;
        }
        this.retry = setTimeout(() => {
            this.retry = undefined;
            this.connect();
        }, this.reconnectMs);
        // Backing off, because a service that is down is usually down for more than a second, and a
        // client that retries every second forever is indistinguishable from something attacking it.
        this.reconnectMs = Math.min(this.reconnectMs * 2, MAX_RECONNECT_MS);
    }

    private receive(message: { type?: string; entry?: EyeEntry; entries?: EyeEntry[]; state?: EyeState }) {
        if (message.type === "state") {
            // The questions changed under us, possibly losing one a watch depends on.
            void this.ensureQuestions();
            return;
        }
        if (message.type === "init") {
            // The backlog is history, not news: it seeds what is true so the first live round is
            // compared against something real, and fires nothing.
            this.yes = new Set(message.state?.yes ?? []);
            return;
        }
        if (message.type !== "entry" || !message.entry) {
            return;
        }
        const entry = message.entry;
        const now = new Set(entry.state);
        for (const watch of [...this.watches]) {
            const was = this.yes.has(watch.question);
            const is = now.has(watch.question);
            if (is && !was) {
                this.safely(() => watch.handlers.onStart?.(entry));
            } else if (was && !is) {
                this.safely(() => watch.handlers.onStop?.(entry));
            }
        }
        this.yes = now;
    }

    /** A throwing callback is the caller's problem, not a reason to stop reading the feed. */
    private safely(run: () => void) {
        try {
            run();
        } catch (error) {
            this.options.onError?.(error as Error);
        }
    }
}
