import * as z from "zod/v4";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "apple-music-mcp";

function readServerVersion(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = resolve(currentDir, "../package.json");
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    if (typeof parsed.version === "string" && parsed.version.trim().length > 0) {
      return parsed.version;
    }
  } catch {
    // Fall back to a safe default if package.json cannot be read.
  }
  return "0.1.0";
}

export const SERVER_VERSION = readServerVersion();

const ID_PATTERN = /^[A-Za-z0-9]{8,32}$/;

export const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe("Non-empty name (max 255 chars).");
export const persistentIdSchema = z
  .string()
  .trim()
  .regex(ID_PATTERN, "Expected a persistent ID-like string.");

export function readBooleanEnv(name: string): boolean {
  const value = process.env[name];
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export const runtimeConfig = Object.freeze({
  writesEnabled: readBooleanEnv("APPLE_MUSIC_MCP_ENABLE_WRITES"),
  dryRun: readBooleanEnv("APPLE_MUSIC_MCP_DRY_RUN"),
});
