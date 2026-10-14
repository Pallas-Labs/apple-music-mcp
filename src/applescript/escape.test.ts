import { describe, expect, test } from "bun:test";
import { runInThisContext } from "node:vm";

import { escapeAppleScriptString, toJavaScriptLiteral } from "./escape.js";

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
    expect(escapeAppleScriptString('a\\b"c\nd\re\tf')).toBe(
      'a\\\\b\\"c\\nd\\re\\tf'
    );
  });

  test("returns empty string unchanged", () => {
    expect(escapeAppleScriptString("")).toBe("");
  });

  test("handles unicode", () => {
    expect(escapeAppleScriptString("caf\u00E9 \u{1F600}")).toBe(
      "caf\u00E9 \u{1F600}"
    );
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

describe("toJavaScriptLiteral", () => {
  test("keeps quotes and backslashes inside the string literal", () => {
    const literal = toJavaScriptLiteral({ name: { _contains: 'a"b\\c' } });
    expect(runInThisContext(`(${literal})`)).toEqual({
      name: { _contains: 'a"b\\c' },
    });
  });

  test("escapes the U+2028 and U+2029 line terminators JSON.stringify leaves raw", () => {
    const separators = String.fromCodePoint(0x20_28, 0x20_29);
    const literal = toJavaScriptLiteral(separators);
    expect(literal).toBe('"\\u2028\\u2029"');
    expect(runInThisContext(`(${literal})`)).toBe(separators);
  });
});
