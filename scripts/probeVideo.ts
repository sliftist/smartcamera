import { FFmpegError, FormatContext } from "node-av";

async function main() {
    const file = process.argv[2];
    if (!file) {
        console.log(`Usage: yarn capture:probe <file.ts>`);
        process.exit(1);
    }
    const input = new FormatContext();
    FFmpegError.throwIfError(await input.openInput(file, null, null), `opening ${file}`);
    FFmpegError.throwIfError(await input.findStreamInfo(null), "reading stream info");
    console.log(`[probe] ${file}`);
    console.log(`[probe] format ${input.iformat?.name}, duration ${(Number(input.duration) / 1_000_000).toFixed(2)}s`);
    for (const stream of input.streams ?? []) {
        const parameters = stream.codecpar;
        console.log(`[probe] stream ${stream.index}: type ${parameters.codecType} codec ${parameters.codecId}`
            + ` ${parameters.width}x${parameters.height} timeBase ${stream.timeBase.num}/${stream.timeBase.den}`
            + ` frames ${stream.nbFrames}`);
    }
    await input.closeInput();
}

main().catch(error => {
    console.error(`[probe] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
