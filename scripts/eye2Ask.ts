const EYE2_URL = "http://127.0.0.1:8770";

async function main() {
    const [rawIndex, ...promptWords] = process.argv.slice(2);
    if (rawIndex === "status" || rawIndex === undefined) {
        const response = await fetch(`${EYE2_URL}/status`);
        console.log(JSON.stringify(await response.json(), undefined, 2));
        return;
    }
    const prompt = promptWords.join(" ");
    if (!prompt) {
        console.log(`Usage: yarn ask2 <index> <prompt>\n       yarn ask2 status`);
        process.exit(1);
    }
    const startedAtMs = Date.now();
    const response = await fetch(EYE2_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index: rawIndex, prompt }),
    });
    const reply = await response.json();
    console.log(`${response.status} in ${Date.now() - startedAtMs}ms: ${JSON.stringify(reply, undefined, 2)}`);
}

main().catch(error => {
    console.error(`[ask2] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
