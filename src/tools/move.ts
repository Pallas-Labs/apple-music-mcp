import * as z from "zod/v4";

import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript } from "../applescript/runner.js";
import type { ExecFn } from "../applescript/runner.js";
import { buildScript } from "../applescript/templates.js";
import { persistentIdSchema } from "../config.js";
import { defineTool, IDEMPOTENT_WRITE_ANNOTATIONS } from "../tool-contracts.js";
import { playlistRowSchema } from "./playlists.js";
import type { Playlist } from "./playlists.js";

const movePlaylistInputSchema = z.object({
  playlistId: persistentIdSchema.describe(
    "Persistent playlist ID from music.list_playlists or music.create_playlist."
  ),
  targetFolderId: persistentIdSchema.describe(
    "Persistent folder ID from music.list_folders or music.create_folder."
  ),
});
const movePlaylistOutputSchema = z.object({
  playlist: z.object({
    folderId: z
      .string()
      .optional()
      .describe("Persistent ID of the folder now holding the playlist."),
    id: z.string().describe("Persistent playlist ID."),
    isSmart: z
      .boolean()
      .describe("True for smart playlists and built-in special playlists."),
    name: z.string(),
    trackCount: z
      .number()
      .optional()
      .describe("Number of tracks in the playlist."),
  }),
});

export const movePlaylistTool = defineTool({
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  description:
    "Move a user playlist into a folder. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  dryRunResult({ playlistId, targetFolderId }) {
    return {
      playlist: {
        id: playlistId,
        name: "DRY_RUN_PLAYLIST",
        folderId: targetFolderId,
        isSmart: false,
        trackCount: 0,
      },
    };
  },
  async handler({ playlistId, targetFolderId }) {
    const playlist = await moveOperations.movePlaylist({
      playlistId,
      targetFolderId,
    });
    return {
      structuredContent: { playlist },
      logData: { playlistId, targetFolderId },
    };
  },
  inputSchema: movePlaylistInputSchema,
  name: "music.move_playlist",
  outputSchema: movePlaylistOutputSchema,
  writesRequired: true,
});

async function movePlaylist(
  input: { playlistId: string; targetFolderId: string },
  execFn: ExecFn | undefined
): Promise<Playlist> {
  const safePlaylistId = escapeAppleScriptString(input.playlistId);
  const safeFolderId = escapeAppleScriptString(input.targetFolderId);
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 40 seconds
            set targetPlaylist to first user playlist whose persistent ID is "${safePlaylistId}"
            set targetFolder to first folder playlist whose persistent ID is "${safeFolderId}"
            move targetPlaylist to targetFolder

            set smartValue to "false"
            try
                if (special kind of targetPlaylist) is not none then
                    set smartValue to "true"
                end if
            end try
            if smartValue is "false" then
                try
                    if smart of targetPlaylist then
                        set smartValue to "true"
                    end if
                end try
            end if

            set trackCountValue to "0"
            try
                set trackCountValue to (count of tracks of targetPlaylist) as text
            end try

            return my jsonPlaylist((persistent ID of targetPlaylist as text), (name of targetPlaylist as text), (persistent ID of targetFolder as text), smartValue, trackCountValue)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonPlaylist(playlistId, playlistName, parentFolderId, smartValue, trackCountValue)
    return "{\\"id\\":\\"" & my jsonEscape(playlistId) & "\\",\\"name\\":\\"" & my jsonEscape(playlistName) & "\\",\\"folderId\\":\\"" & my jsonEscape(parentFolderId) & "\\",\\"isSmart\\":" & smartValue & ",\\"trackCount\\":" & trackCountValue & "}"
end jsonPlaylist`;

  const result = await runAppleScript(buildScript(body), 50_000, execFn);
  const parsed = parseAppleScriptJson(
    result.stdout,
    playlistRowSchema,
    "Music returned an invalid move playlist payload."
  );
  const folderId = parsed.folderId.trim();
  return {
    id: parsed.id,
    name: parsed.name,
    isSmart: parsed.isSmart,
    ...(folderId.length > 0 ? { folderId } : {}),
    trackCount: parsed.trackCount,
  };
}

export function createMoveOperations(execFn?: ExecFn) {
  return {
    movePlaylist: async (input: {
      playlistId: string;
      targetFolderId: string;
    }) => movePlaylist(input, execFn),
  };
}

const moveOperations = createMoveOperations();
