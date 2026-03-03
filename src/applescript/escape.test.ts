import { describe, expect, test } from "bun:test";
import { escapeAppleScriptString } from "./escape.js";

describe("escapeAppleScriptString", () => {
    test("escapes backslashes", () => {
        expect(escapeAppleScriptString("a\\b")).toBe("a\\\\b");
    });

    test("escapes double quotes", () => {
        expect(escapeAppleScriptString('say "hello"')).toBe('say \\"hello\\"');
    });

    test("escapes newlines", () => {
        expect(escapeAppleScriptString("line1\nline2")).toBe("line1\\nline2");
    });

    test("escapes carriage returns", () => {
        expect(escapeAppleScriptString("line1\rline2")).toBe("line1\\rline2");
    });

    test("escapes tabs", () => {
        expect(escapeAppleScriptString("col1\tcol2")).toBe("col1\\tcol2");
    });

    test("handles combined special chars", () => {
        expect(escapeAppleScriptString('a\\b"c\nd\re\tf')).toBe('a\\\\b\\"c\\nd\\re\\tf');
    });

    test("returns empty string unchanged", () => {
        expect(escapeAppleScriptString("")).toBe("");
    });

    test("handles unicode", () => {
        expect(escapeAppleScriptString("caf\u00e9 \u{1f600}")).toBe("caf\u00e9 \u{1f600}");
    });

    test("handles long strings without issue", () => {
        const long = "a".repeat(10_000);
        expect(escapeAppleScriptString(long)).toBe(long);
    });

    test("escapes backslash before quote (order matters)", () => {
        // Input: \" should become \\\"
        expect(escapeAppleScriptString('\\"')).toBe('\\\\\\"');
    });
});
