import * as z from "zod/v4";

import { runAppleScript } from "../applescript/runner.js";
import { SERVER_VERSION } from "../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "../tool-contracts.js";
import { MusicToolError } from "../types.js";

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
  const result = await runAppleScript(script, 2000);
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
  const result = await runAppleScript(script, 5000);
  if (!result.stdout.startsWith("error:")) {
    return true;
  }

  const errorNumber = Number(result.stdout.replace("error:", ""));
  if (errorNumber === -1743 || errorNumber === -10_004) {
    return false;
  }
  if (
    errorNumber === -600 ||
    errorNumber === -10_810 ||
    errorNumber === -1728 ||
    errorNumber === -43
  ) {
    return false;
  }
  return true;
}

async function getMusicHealth() {
  const musicRunning = await isMusicRunning();
  let permissionGranted = false;

  if (musicRunning) {
    try {
      permissionGranted = await checkMusicPermission();
    } catch (error) {
      if (!(error instanceof MusicToolError)) {
        throw error;
      }
      if (
        error.code !== "permission_denied" &&
        error.code !== "music_not_running"
      ) {
        throw error;
      }
    }
  }

  return { musicRunning, permissionGranted, serverVersion: SERVER_VERSION };
}

const healthInputSchema = z.object({});
const healthOutputSchema = z.object({
  dryRun: z
    .boolean()
    .describe(
      "True when mutation tools return previews without changing Music."
    ),
  musicRunning: z.boolean(),
  permissionGranted: z
    .boolean()
    .describe(
      "True when macOS lets this process automate Music. Always false if Music is not running."
    ),
  serverVersion: z.string(),
  writesEnabled: z
    .boolean()
    .describe("True when mutation tools may change Apple Music."),
});

export const healthTool = defineTool({
  annotations: READ_ONLY_ANNOTATIONS,
  description:
    "Check that Apple Music is running and that automation permission is granted. Call this first.",
  async handler(_input, { config }) {
    const health = await getMusicHealth();
    const response = {
      ...health,
      writesEnabled: config.writesEnabled,
      dryRun: config.dryRun,
    };
    return {
      structuredContent: response,
      logData: {
        musicRunning: health.musicRunning,
        permissionGranted: health.permissionGranted,
      },
    };
  },
  inputSchema: healthInputSchema,
  name: "music.health",
  outputSchema: healthOutputSchema,
  writesRequired: false,
});
