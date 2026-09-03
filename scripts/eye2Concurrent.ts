const EYE2_URL = "http://127.0.0.1:8770";

const PROMPTS = [
    "is a person in the image, yes or no, no explanation or preamble",
    "is it daytime in the image, yes or no, no explanation or preamble",
    "is there a chair in the image, yes or no, no explanation or preamble",
];

async function main() {
    const index = process.argv[2] ?? "2";
    console.log(`[concurrent] firing ${PROMPTS.length} prompts at index ${index} at once`);
    const startedAtMs = Date.now();
    const replies = await Promise.all(PROMPTS.map(async prompt => {
        const response = await fetch(EYE2_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ index, prompt }),
        });
        return { prompt, status: response.status, reply: await response.json() as Record<string, unknown> };
    }));
    for (const { prompt, status, reply } of replies) {
        console.log(`[concurrent] ${status} "${prompt.slice(0, 34)}" -> ${JSON.stringify(reply.answer ?? reply.error)}`
            + ` keyframe ${reply.keyframeAt} decode ${reply.decodeMs}ms analyze ${Number(reply.analyzeMs ?? 0).toFixed(0)}ms`);
    }
    const shared = new Set(replies.map(entry => String(entry.reply.keyframeAt)));
    console.log(`[concurrent] all ${replies.length} answers took ${Date.now() - startedAtMs}ms and used ${shared.size} decoded image(s)`);
}

main().catch(error => {
    console.error(`[concurrent] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
