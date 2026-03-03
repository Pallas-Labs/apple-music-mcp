import * as z from "zod/v4";
import { SERVER_VERSION, runtimeConfig } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { MusicToolError } from "../types.js";
import type { MusicHealth } from "../types.js";
import type { ToolDef } from "../server.js";

async function isMusicRunning(): Promise<boolean> {
  const script = `
try
    if application "Music" is running then
        return "running"
    else
        return "not_running"
    end if
on error
    return "not_running"
end try
`;
  const result = await runAppleScript(script, 2_000);
  return result.stdout === "running";
}

async function checkMusicPermission(): Promise<boolean> {
  const script = `
try
    tell application "Music" to launch
    return "ok"
on error errMsg number errNum
    return "error:" & errNum
end try
`;
  const result = await runAppleScript(script, 5_000);
  if (!result.stdout.startsWith("error:")) return true;

  const errorNumber = Number(result.stdout.replace("error:", ""));
  if (errorNumber === -1743 || errorNumber === -10004) return false;
  if (
    errorNumber === -600 ||
    errorNumber === -10810 ||
    errorNumber === -1728 ||
    errorNumber === -43
  )
    return false;
  return true;
}

async function getMusicHealth(): Promise<MusicHealth> {
  const musicRunning = await isMusicRunning();
  let permissionGranted = false;

  if (musicRunning) {
    try {
      permissionGranted = await checkMusicPermission();
    } catch (error) {
      if (!(error instanceof MusicToolError)) throw error;
      if (error.code !== "permission_denied" && error.code !== "music_not_running") throw error;
    }
  }

  return { musicRunning, permissionGranted, serverVersion: SERVER_VERSION };
}

export const healthTool: ToolDef = {
  name: "music.health",
  description: "Check Apple Music availability and automation permission status.",
  inputSchema: {},
  outputSchema: {
    musicRunning: z.boolean(),
    permissionGranted: z.boolean(),
    serverVersion: z.string(),
    writesEnabled: z.boolean(),
    dryRun: z.boolean(),
  },
  writesRequired: false,
  async handler() {
    const health = await getMusicHealth();
    const response = {
      ...health,
      writesEnabled: runtimeConfig.writesEnabled,
      dryRun: runtimeConfig.dryRun,
    };
    return {
      structuredContent: response,
      logData: { musicRunning: health.musicRunning, permissionGranted: health.permissionGranted },
    };
  },
};
