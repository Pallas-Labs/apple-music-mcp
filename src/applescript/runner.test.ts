import { describe, expect, test } from "bun:test";
import { runAppleScript, parseAppleScriptErrorNumber, mapAppleScriptError } from "./runner.js";
import type { ExecFn } from "./runner.js";
import { MusicToolError } from "../types.js";

describe("parseAppleScriptErrorNumber", () => {
    test("returns last error number from stderr", () => {
        expect(parseAppleScriptErrorNumber("error one (-1743) and error two (-1728)")).toBe(-1728);
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
        const mapped = mapAppleScriptError({ stderr: "", code: "ETIMEDOUT" });
        expect(mapped.code).toBe("timeout");
    });

    test("maps SIGTERM to timeout", () => {
        const mapped = mapAppleScriptError({ stderr: "", signal: "SIGTERM" });
        expect(mapped.code).toBe("timeout");
    });

    test("maps -1743 to permission_denied", () => {
        const mapped = mapAppleScriptError({ stderr: "execution error (-1743)", code: "1" });
        expect(mapped.code).toBe("permission_denied");
    });

    test("maps -10004 to permission_denied", () => {
        const mapped = mapAppleScriptError({ stderr: "execution error (-10004)", code: "1" });
        expect(mapped.code).toBe("permission_denied");
    });

    test("maps -600 to music_not_running", () => {
        const mapped = mapAppleScriptError({ stderr: "error (-600)", code: "1" });
        expect(mapped.code).toBe("music_not_running");
    });

    test("maps -1728 with app reference to music_not_running", () => {
        const mapped = mapAppleScriptError({
            stderr: 'Can\'t get application id "com.apple.Music". (-1728)',
            code: "1",
        });
        expect(mapped.code).toBe("music_not_running");
    });

    test("maps -1728 without app reference to not_found", () => {
        const mapped = mapAppleScriptError({
            stderr: 'Can\'t get first user playlist whose persistent ID is "ABC". (-1728)',
            code: "1",
        });
        expect(mapped.code).toBe("not_found");
    });

    test("maps unknown error to script_error", () => {
        const mapped = mapAppleScriptError({ stderr: "something weird", code: "1" });
        expect(mapped.code).toBe("script_error");
    });
});

describe("runAppleScript", () => {
    test("returns stdout/stderr from exec function", async () => {
        const mockExec: ExecFn = async () => ({ stdout: "hello", stderr: "" });
        const result = await runAppleScript("script", 5000, mockExec);
        expect(result.stdout).toBe("hello");
    });

    test("maps exec errors to MusicToolError", async () => {
        const mockExec: ExecFn = async () => {
            const err = new Error("timeout") as any;
            err.code = "ETIMEDOUT";
            err.stderr = "";
            throw err;
        };
        try {
            await runAppleScript("script", 5000, mockExec);
            expect(true).toBe(false); // should not reach
        } catch (error) {
            expect(error).toBeInstanceOf(MusicToolError);
            expect((error as MusicToolError).code).toBe("timeout");
        }
    });

    test("passes script and timeout to exec function", async () => {
        let receivedScript = "";
        let receivedTimeout = 0;
        const mockExec: ExecFn = async (script, timeout) => {
            receivedScript = script;
            receivedTimeout = timeout;
            return { stdout: "", stderr: "" };
        };
        await runAppleScript("test-script", 42_000, mockExec);
        expect(receivedScript).toBe("test-script");
        expect(receivedTimeout).toBe(42_000);
    });

    test("normalizes quoted scalar stdout", async () => {
        const mockExec: ExecFn = async () => ({ stdout: '"running"', stderr: "" });
        const result = await runAppleScript("script", 5000, mockExec);
        expect(result.stdout).toBe("running");
    });

    test("normalizes quoted JSON-string stdout", async () => {
        const mockExec: ExecFn = async () => ({ stdout: '"[{\\"id\\":\\"A\\"}]"', stderr: "" });
        const result = await runAppleScript("script", 5000, mockExec);
        expect(result.stdout).toBe('[{"id":"A"}]');
    });
});
