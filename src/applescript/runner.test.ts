import { describe, expect, mock, test } from "bun:test";

import { MusicToolError } from "../types.js";
import {
  runAppleScript,
  runJavaScript,
  parseAppleScriptErrorNumber,
  mapAppleScriptError,
} from "./runner.js";
import type { ExecFn } from "./runner.js";

const execReturning = (stdout: string) =>
  mock<ExecFn>().mockResolvedValue({ stderr: "", stdout });

const execRejecting = (error: Error) => mock<ExecFn>().mockRejectedValue(error);

const errorOf = async <T>(promise: Promise<T>): Promise<MusicToolError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MusicToolError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the promise to reject with a MusicToolError.");
};

describe("parseAppleScriptErrorNumber", () => {
  test("returns last error number from stderr", () => {
    expect(
      parseAppleScriptErrorNumber("error one (-1743) and error two (-1728)")
    ).toBe(-1728);
  });

  test("returns null when no error number is present", () => {
    expect(parseAppleScriptErrorNumber("plain stderr")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseAppleScriptErrorNumber("")).toBeNull();
  });

  test("handles single error number", () => {
    expect(parseAppleScriptErrorNumber("execution error (-600)")).toBe(-600);
  });

  test("handles positive error number", () => {
    expect(parseAppleScriptErrorNumber("some error (42)")).toBe(42);
  });
});

describe("mapAppleScriptError", () => {
  test("maps ETIMEDOUT to timeout", () => {
    const mapped = mapAppleScriptError({ code: "ETIMEDOUT", stderr: "" });
    expect(mapped.code).toBe("timeout");
  });

  test("maps SIGTERM to timeout", () => {
    const mapped = mapAppleScriptError({ signal: "SIGTERM", stderr: "" });
    expect(mapped.code).toBe("timeout");
  });

  test("maps -1743 to permission_denied", () => {
    const mapped = mapAppleScriptError({
      code: "1",
      stderr: "execution error (-1743)",
    });
    expect(mapped.code).toBe("permission_denied");
  });

  test("maps -10004 to permission_denied", () => {
    const mapped = mapAppleScriptError({
      code: "1",
      stderr: "execution error (-10004)",
    });
    expect(mapped.code).toBe("permission_denied");
  });

  test("maps -600 to music_not_running", () => {
    const mapped = mapAppleScriptError({ code: "1", stderr: "error (-600)" });
    expect(mapped.code).toBe("music_not_running");
  });

  test("maps -1728 with app reference to music_not_running", () => {
    const mapped = mapAppleScriptError({
      code: "1",
      stderr: 'Can\'t get application id "com.apple.Music". (-1728)',
    });
    expect(mapped.code).toBe("music_not_running");
  });

  test("maps -1728 without app reference to not_found", () => {
    const mapped = mapAppleScriptError({
      code: "1",
      stderr:
        'Can\'t get first user playlist whose persistent ID is "ABC". (-1728)',
    });
    expect(mapped.code).toBe("not_found");
  });

  test("maps -1728 entity errors with trailing app context to not_found", () => {
    const mapped = mapAppleScriptError({
      code: "1",
      stderr:
        'Can\'t get first user playlist whose persistent ID is "ABC" of application "Music". (-1728)',
    });
    expect(mapped.code).toBe("not_found");
  });

  test("maps unknown error to script_error", () => {
    const mapped = mapAppleScriptError({
      code: "1",
      stderr: "something weird",
    });
    expect(mapped.code).toBe("script_error");
  });
});

describe("runAppleScript", () => {
  test("returns stdout/stderr from exec function", async () => {
    const result = await runAppleScript("script", 5000, execReturning("hello"));
    expect(result.stdout).toBe("hello");
  });

  test("maps exec errors to MusicToolError", async () => {
    const mockExec = execRejecting(
      Object.assign(new Error("timeout"), { code: "ETIMEDOUT", stderr: "" })
    );
    const error = await errorOf(runAppleScript("script", 5000, mockExec));
    expect(error.code).toBe("timeout");
  });

  test("passes script, timeout, and language to exec function", async () => {
    const mockExec = execReturning("");
    await runAppleScript("test-script", 42_000, mockExec);
    await runJavaScript("js-script", 7000, mockExec);
    expect(mockExec.mock.calls).toEqual([
      ["test-script", 42_000, "AppleScript"],
      ["js-script", 7000, "JavaScript"],
    ]);
  });

  test("maps JXA errors through the AppleScript error numbers", async () => {
    const mockExec = execRejecting(
      Object.assign(new Error("exec"), {
        code: 1,
        stderr: "execution error: Error: Error: Can't get object. (-1728)",
      })
    );
    const error = await errorOf(runJavaScript("script", 5000, mockExec));
    expect(error.code).toBe("not_found");
  });

  test("normalizes quoted scalar stdout", async () => {
    const result = await runAppleScript(
      "script",
      5000,
      execReturning('"running"')
    );
    expect(result.stdout).toBe("running");
  });

  test("normalizes quoted JSON-string stdout", async () => {
    const result = await runAppleScript(
      "script",
      5000,
      execReturning('"[{\\"id\\":\\"A\\"}]"')
    );
    expect(result.stdout).toBe('[{"id":"A"}]');
  });
});
