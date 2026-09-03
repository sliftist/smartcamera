const EYE2_URL = "http://127.0.0.1:8770";

const CASES: { label: string; body: Record<string, unknown> }[] = [
    { label: "path traversal", body: { index: "../../view3.bat", prompt: "hi" } },
    { label: "absolute path", body: { index: "C:/Windows/System32/view3.bat", prompt: "hi" } },
    { label: "negative", body: { index: "-1", prompt: "hi" } },
    { label: "float", body: { index: "1.5", prompt: "hi" } },
    { label: "out of range", body: { index: "99", prompt: "hi" } },
    { label: "not a number", body: { index: "abc", prompt: "hi" } },
    { label: "missing index", body: { prompt: "hi" } },
    { label: "missing prompt", body: { index: "2" } },
    { label: "empty prompt", body: { index: "2", prompt: "   " } },
    { label: "oversized prompt", body: { index: "2", prompt: "x".repeat(5000) } },
];

async function main() {
    for (const { label, body } of CASES) {
        const response = await fetch(EYE2_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const reply = await response.json() as Record<string, unknown>;
        const verdict = response.status === 400 ? "rejected" : `ALLOWED (${response.status})`;
        console.log(`[security] ${label.padEnd(18)} ${verdict}: ${reply.error ?? JSON.stringify(reply).slice(0, 80)}`);
    }
}

main().catch(error => {
    console.error(`[security] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
