import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readBooleanEnv, SERVER_VERSION } from "./config.js";

describe("readBooleanEnv", () => {
  test("returns false for unset var", () => {
    delete process.env["__TEST_BOOL__"];
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(false);
  });

  test("returns true for '1'", () => {
    process.env["__TEST_BOOL__"] = "1";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(true);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns true for 'true'", () => {
    process.env["__TEST_BOOL__"] = "true";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(true);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns true for 'TRUE' (case insensitive)", () => {
    process.env["__TEST_BOOL__"] = "TRUE";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(true);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns true for 'yes'", () => {
    process.env["__TEST_BOOL__"] = "yes";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(true);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns true for 'on'", () => {
    process.env["__TEST_BOOL__"] = "on";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(true);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns false for 'false'", () => {
    process.env["__TEST_BOOL__"] = "false";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(false);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns false for '0'", () => {
    process.env["__TEST_BOOL__"] = "0";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(false);
    delete process.env["__TEST_BOOL__"];
  });

  test("returns false for empty string", () => {
    process.env["__TEST_BOOL__"] = "";
    expect(readBooleanEnv("__TEST_BOOL__")).toBe(false);
    delete process.env["__TEST_BOOL__"];
  });
});

describe("SERVER_VERSION", () => {
  test("matches package.json version", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
    };
    expect(SERVER_VERSION).toBe(packageJson.version);
  });
});
