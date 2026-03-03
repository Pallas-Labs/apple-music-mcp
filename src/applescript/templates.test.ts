import { describe, expect, test } from "bun:test";
import { buildScript, buildRawScript } from "./templates.js";

describe("buildScript", () => {
  test("prepends Music launch preamble", () => {
    const script = buildScript('tell application id "com.apple.Music"\nend tell');
    expect(script).toContain('application "Music" is not running');
    expect(script).toContain('tell application "Music" to launch');
  });

  test("appends jsonEscape handler", () => {
    const script = buildScript("-- body");
    expect(script).toContain("on jsonEscape(sourceText)");
    expect(script).toContain("on replaceText(findText, replaceText, sourceText)");
  });

  test("includes the body", () => {
    const script = buildScript("set x to 42");
    expect(script).toContain("set x to 42");
  });
});

describe("buildRawScript", () => {
  test("returns body as-is", () => {
    const body = 'return "hello"';
    expect(buildRawScript(body)).toBe(body);
  });
});
