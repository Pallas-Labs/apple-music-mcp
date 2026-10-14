import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CustomPromisify } from "node:util";

import * as z from "zod/v4";

import { MusicToolError } from "../types.js";

// Typed as Node's custom promisify form, which attaches stdout and stderr to a rejected error.
const promisifiableExecFile: CustomPromisify<typeof execFile.__promisify__> =
  execFile;
const execFileAsync = promisify(promisifiableExecFile);

export interface AppleScriptExecResult {
  stdout: string;
  stderr: string;
}

const execErrorSchema = z.object({
  code: z.union([z.string(), z.number()]).nullish(),
  signal: z.string().nullish(),
  stderr: z.string().nullish(),
});

type AppleScriptExecError = z.output<typeof execErrorSchema>;

const normalizeAppleScriptStdout = (stdout: string): string => {
  const trimmed = stdout.trim();
  if (!(trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed;
  }

  try {
    return z.string().parse(JSON.parse(trimmed));
  } catch {
    // Keep original output when unquoting fails.
    return trimmed;
  }
};

export type ScriptLanguage = "AppleScript" | "JavaScript";

export type ExecFn = (
  script: string,
  timeoutMs: number,
  language: ScriptLanguage
) => Promise<AppleScriptExecResult>;

const defaultExecFn: ExecFn = async (script, timeoutMs, language) => {
  // JXA prints its string result raw, so it skips the source-form quoting AppleScript needs.
  const languageArgs =
    language === "JavaScript"
      ? ["-l", "JavaScript", "-e", script]
      : ["-s", "s", "-e", script];
  const { stdout, stderr } = await execFileAsync("osascript", languageArgs, {
    encoding: "utf-8",
    // Bulk track reads can return tens of thousands of JSON rows.
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return {
    stderr: stderr.trim(),
    stdout: stdout.trim(),
  };
};

export const parseAppleScriptErrorNumber = (stderr: string): number | null => {
  const matches = stderr.match(/\((?<errorNumber>-?\d+)\)/gu);
  if (!matches || matches.length === 0) {
    return null;
  }
  const last = matches.at(-1);
  if (last === undefined) {
    return null;
  }
  const numeric = Number(last.replaceAll(/[()]/gu, ""));
  return Number.isFinite(numeric) ? numeric : null;
};

export const mapAppleScriptError = (
  error: AppleScriptExecError
): MusicToolError => {
  const stderr = (error.stderr ?? "").trim();
  const errorNumber = parseAppleScriptErrorNumber(stderr);

  if (error.code === "ETIMEDOUT" || error.signal === "SIGTERM") {
    return new MusicToolError("timeout", "AppleScript command timed out", {
      stderr,
    });
  }

  if (errorNumber === -1743 || errorNumber === -10_004) {
    return new MusicToolError(
      "permission_denied",
      "Permission denied to control Music. Grant automation access in System Settings > Privacy & Security > Automation.",
      { errorNumber, stderr }
    );
  }

  if (errorNumber === -600 || errorNumber === -10_810) {
    return new MusicToolError(
      "music_not_running",
      "Music app is not running or unavailable.",
      {
        errorNumber,
        stderr,
      }
    );
  }

  if (errorNumber === -1728) {
    if (
      stderr.includes('Can\'t get application id "com.apple.Music"') ||
      stderr.includes('Can\'t get application "Music"')
    ) {
      return new MusicToolError(
        "music_not_running",
        "Music app is not running or unavailable.",
        {
          errorNumber,
          stderr,
        }
      );
    }
    return new MusicToolError("not_found", "Music entity not found.", {
      errorNumber,
      stderr,
    });
  }

  return new MusicToolError("script_error", "Failed to execute AppleScript.", {
    code: error.code,
    errorNumber,
    stderr,
  });
};

const runScript = async (
  script: string,
  timeoutMs: number,
  language: ScriptLanguage,
  execFn: ExecFn
): Promise<AppleScriptExecResult> => {
  try {
    const result = await execFn(script, timeoutMs, language);
    return {
      stderr: result.stderr.trim(),
      stdout: normalizeAppleScriptStdout(result.stdout),
    };
  } catch (error) {
    const parsed = execErrorSchema.safeParse(error);
    throw mapAppleScriptError(parsed.success ? parsed.data : {});
  }
};

export const runAppleScript = async (
  script: string,
  timeoutMs = 15_000,
  execFn: ExecFn = defaultExecFn
): Promise<AppleScriptExecResult> =>
  await runScript(script, timeoutMs, "AppleScript", execFn);

/** Run a JXA script. Errors surface with the same AppleScript error numbers. */
export const runJavaScript = async (
  script: string,
  timeoutMs = 15_000,
  execFn: ExecFn = defaultExecFn
): Promise<AppleScriptExecResult> =>
  await runScript(script, timeoutMs, "JavaScript", execFn);
