import { readFileSync } from "node:fs";
import path from "node:path";

import * as z from "zod/v4";

export const SERVER_NAME = "apple-music-mcp";

const PackageJsonSchema = z.object({
  version: z.string().refine((version) => version.trim().length > 0),
});

const readServerVersion = (): string => {
  const packageJsonPath = path.resolve(import.meta.dirname, "../package.json");
  try {
    const raw = readFileSync(packageJsonPath, "utf-8");
    const parsed = PackageJsonSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      return parsed.data.version;
    }
  } catch {
    // Fall back to a safe default if package.json cannot be read.
  }
  return "0.1.0";
};

export const SERVER_VERSION = readServerVersion();

const ID_PATTERN = /^[A-Za-z0-9]{8,32}$/u;

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

export const readBooleanEnv = (name: string): boolean => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
};

export const runtimeConfig = Object.freeze({
  dryRun: readBooleanEnv("APPLE_MUSIC_MCP_DRY_RUN"),
  writesEnabled: readBooleanEnv("APPLE_MUSIC_MCP_ENABLE_WRITES"),
});

export type RuntimeConfig = typeof runtimeConfig;
