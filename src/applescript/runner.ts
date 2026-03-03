import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MusicToolError } from "../types.js";

const execFileAsync = promisify(execFile);

export type AppleScriptExecResult = {
    stdout: string;
    stderr: string;
};

type AppleScriptExecError = NodeJS.ErrnoException & {
    stderr?: string;
    stdout?: string;
    signal?: NodeJS.Signals;
};

function normalizeAppleScriptStdout(stdout: string): string {
    const trimmed = stdout.trim();
    if (!(trimmed.startsWith("\"") && trimmed.endsWith("\""))) {
        return trimmed;
    }

    try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed === "string") {
            return parsed;
        }
    } catch {
        // Keep original output when unquoting fails.
    }

    return trimmed;
}

export type ExecFn = (script: string, timeoutMs: number) => Promise<AppleScriptExecResult>;

const defaultExecFn: ExecFn = async (script, timeoutMs) => {
    const { stdout, stderr } = await execFileAsync("osascript", ["-s", "s", "-e", script], {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
    });
    return {
        stdout: stdout.trim(),
        stderr: (stderr ?? "").trim(),
    };
};

export function parseAppleScriptErrorNumber(stderr: string): number | null {
    const matches = stderr.match(/\((-?\d+)\)/g);
    if (!matches || matches.length === 0) return null;
    const last = matches[matches.length - 1];
    if (!last) return null;
    const numeric = Number(last.replace(/[()]/g, ""));
    return Number.isFinite(numeric) ? numeric : null;
}

export function mapAppleScriptError(error: AppleScriptExecError): MusicToolError {
    const stderr = (error.stderr ?? "").trim();
    const errorNumber = parseAppleScriptErrorNumber(stderr);

    if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
        return new MusicToolError("timeout", "AppleScript command timed out", { stderr });
    }

    if (errorNumber === -1743 || errorNumber === -10004) {
        return new MusicToolError(
            "permission_denied",
            "Permission denied to control Music. Grant automation access in System Settings > Privacy & Security > Automation.",
            { stderr, errorNumber },
        );
    }

    if (errorNumber === -600 || errorNumber === -10810) {
        return new MusicToolError("music_not_running", "Music app is not running or unavailable.", {
            stderr,
            errorNumber,
        });
    }

    if (errorNumber === -1728) {
        if (stderr.includes('application id "com.apple.Music"') || stderr.includes('application "Music"')) {
            return new MusicToolError("music_not_running", "Music app is not running or unavailable.", {
                stderr,
                errorNumber,
            });
        }
        return new MusicToolError("not_found", "Music entity not found.", { stderr, errorNumber });
    }

    return new MusicToolError("script_error", "Failed to execute AppleScript.", {
        stderr,
        errorNumber,
        code: error.code,
    });
}

export async function runAppleScript(
    script: string,
    timeoutMs = 15_000,
    execFn: ExecFn = defaultExecFn,
): Promise<AppleScriptExecResult> {
    try {
        const result = await execFn(script, timeoutMs);
        return {
            stdout: normalizeAppleScriptStdout(result.stdout),
            stderr: result.stderr.trim(),
        };
    } catch (error) {
        throw mapAppleScriptError(error as AppleScriptExecError);
    }
}
