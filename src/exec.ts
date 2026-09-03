import { spawn } from "child_process";

export type ExecResult = {
    code: number;
    stdout: string;
    stderr: string;
};

export type ExecOptions = {
    cwd?: string;
    env?: Record<string, string>;
    quiet?: boolean;
    prefix?: string;
    onLine?: (line: string) => void;
};

export async function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const prefix = options.prefix ?? "[exec]";
    if (!options.quiet) {
        console.log(`${prefix} $ ${command} ${args.join(" ")}`);
    }
    return await new Promise<ExecResult>(resolve => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env ? { ...process.env, ...options.env } : process.env,
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
        });
        let stdout = "";
        let stderr = "";
        let pendingOut = "";
        let pendingErr = "";
        const emit = (line: string) => {
            if (options.onLine) {
                options.onLine(line);
            }
            if (!options.quiet) {
                console.log(`${prefix} ${line}`);
            }
        };
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => {
            stdout += chunk;
            pendingOut += chunk;
            const lines = pendingOut.split(/\r?\n/);
            pendingOut = lines.pop() ?? "";
            for (const line of lines) {
                emit(line);
            }
        });
        child.stderr.on("data", chunk => {
            stderr += chunk;
            pendingErr += chunk;
            const lines = pendingErr.split(/\r?\n/);
            pendingErr = lines.pop() ?? "";
            for (const line of lines) {
                emit(line);
            }
        });
        child.on("error", error => {
            resolve({ code: -1, stdout, stderr: `${stderr}${(error as Error).stack ?? error}` });
        });
        child.on("close", code => {
            if (pendingOut) {
                emit(pendingOut);
            }
            if (pendingErr) {
                emit(pendingErr);
            }
            resolve({ code: code ?? -1, stdout, stderr });
        });
    });
}

export async function capture(command: string, args: string[], options: ExecOptions = {}): Promise<string | undefined> {
    const result = await exec(command, args, { ...options, quiet: true });
    if (result.code !== 0) {
        return undefined;
    }
    return result.stdout.trim();
}

export async function execOrThrow(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
    const result = await exec(command, args, options);
    if (result.code !== 0) {
        throw new Error(`Expected \`${command} ${args.join(" ")}\` to succeed, it exited ${result.code}\n${result.stderr || result.stdout}`);
    }
    return result;
}
