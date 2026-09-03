import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { capture, exec } from "../src/exec";

const HUGGING_FACE_TOKEN_FILES = [
    path.join(os.homedir(), "facehuggingtoken.txt"),
    path.join(os.homedir(), "huggingface.txt"),
];

async function probe(label: string, command: string, args: string[]) {
    const value = await capture(command, args);
    if (value === undefined) {
        console.log(`[env] ${label}: absent`);
        return undefined;
    }
    const lines = value.split(/\r?\n/).filter(line => line.trim());
    console.log(`[env] ${label}: ${lines[0]}`);
    for (const line of lines.slice(1)) {
        console.log(`[env]     ${line}`);
    }
    return value;
}

async function main() {
    console.log(`[env] ${os.platform()} ${os.release()}, ${os.cpus().length} cpus, ${(os.totalmem() / 2 ** 30).toFixed(1)} GiB ram`);
    console.log(`[env] node ${process.version}`);

    await probe("nvidia-smi", "nvidia-smi", ["--query-gpu=name,driver_version,memory.total,compute_cap", "--format=csv,noheader"]);
    await probe("nvcc", "nvcc", ["--version"]);
    await probe("python", "python", ["-V"]);
    await probe("py -0p", "py", ["-0p"]);
    await probe("uv", "uv", ["--version"]);
    await probe("python -m uv", "python", ["-m", "uv", "--version"]);
    await probe("docker", "docker", ["--version"]);
    await probe("wsl", "wsl.exe", ["--status"]);
    await probe("wsl distros", "wsl.exe", ["--list", "--verbose"]);

    for (const file of HUGGING_FACE_TOKEN_FILES) {
        if (fs.existsSync(file)) {
            const token = fs.readFileSync(file, "utf8").trim();
            console.log(`[env] token ${file}: present (${token.length} chars, ${token.slice(0, 4)}...)`);
        } else {
            console.log(`[env] token ${file}: absent`);
        }
    }

    for (const drive of ["C:/", "D:/"]) {
        const result = await exec("powershell", ["-NoProfile", "-Command", `(Get-PSDrive ${drive[0]}).Free`], { quiet: true });
        if (result.code === 0) {
            console.log(`[env] free on ${drive}: ${(Number(result.stdout.trim()) / 2 ** 30).toFixed(1)} GiB`);
        }
    }
}

main().catch(error => {
    console.error(`[env] failed:`, (error as Error).stack ?? error);
    process.exit(1);
});
