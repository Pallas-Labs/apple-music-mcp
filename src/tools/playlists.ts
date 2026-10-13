import * as z from "zod/v4";
import { nameSchema, persistentIdSchema } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Playlist } from "../types.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  READ_ONLY_ANNOTATIONS,
} from "../tool-contracts.js";
import {
  addTracksToPlaylist,
  findTracks,
  scannedOutputSchema,
  trackCriteriaSchema,
  truncatedOutputSchema,
  type AddTracksResult,
} from "./tracks.js";

export const playlistSchema = z.object({
  id: z.string().describe("Persistent playlist ID."),
  name: z.string(),
  folderId: z
    .string()
    .optional()
    .describe("Persistent ID of the parent folder. Omitted for top-level playlists."),
  isSmart: z.boolean().describe("True for smart playlists and built-in special playlists."),
  trackCount: z
    .number()
    .optional()
    .describe("Number of tracks. Omitted by music.list_playlists to keep listing fast."),
});
const listPlaylistsInputSchema = z.object({
  folderId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Returns only playlists directly inside it.",
    ),
  includeRoot: z
    .boolean()
    .optional()
    .describe("Include top-level playlists (default true). Ignored when folderId is set."),
});
const listPlaylistsOutputSchema = z.object({
  playlists: z.array(playlistSchema),
});
const createPlaylistInputSchema = z.object({
  name: nameSchema.describe("Playlist name, 1-255 characters."),
  folderId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Omit to create at the top level.",
    ),
});
const createPlaylistOutputSchema = z.object({
  playlist: playlistSchema,
});
const createPlaylistFromCriteriaInputSchema = z.object({
  name: nameSchema.describe("Playlist name, 1-255 characters."),
  folderId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Omit to create at the top level.",
    ),
  criteria: trackCriteriaSchema.describe(
    "Track filters, with the same rules as music.find_tracks. At least one filter is required.",
  ),
});
const createPlaylistFromCriteriaOutputSchema = z.object({
  playlist: playlistSchema,
  matched: z
    .number()
    .describe(
      "Number of scanned tracks that matched. When truncated is true, this is a lower bound within the scanned window, not a full-library total.",
    ),
  requested: z
    .number()
    .describe("Number of matched tracks the server tried to add, at most criteria.limit."),
  added: z.number().describe("Number of tracks added. Equals addedTrackIds.length."),
  addedTrackIds: z.array(z.string()).describe("Persistent IDs of tracks added to the playlist."),
  missingTrackIds: z
    .array(z.string())
    .describe("IDs that were not found in the library when the server tried to add them."),
  failedTrackIds: z
    .array(z.string())
    .describe("IDs that were found in the library but could not be added to the playlist."),
  scanned: scannedOutputSchema,
  truncated: truncatedOutputSchema,
});

export const listPlaylistsTool = defineTool({
  name: "music.list_playlists",
  description:
    "List Apple Music user playlists with their persistent IDs, optionally only those inside one folder.",
  inputSchema: listPlaylistsInputSchema,
  outputSchema: listPlaylistsOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  writesRequired: false,
  async handler({ folderId, includeRoot }) {
    const input: { folderId?: string; includeRoot?: boolean } = {};
    if (folderId !== undefined) input.folderId = folderId;
    if (includeRoot !== undefined) input.includeRoot = includeRoot;
    const playlists = await listPlaylists(input);
    return {
      structuredContent: { playlists },
      logData: { playlistCount: playlists.length, hasFolderFilter: Boolean(folderId) },
    };
  },
});

export const createPlaylistTool = defineTool({
  name: "music.create_playlist",
  description:
    "Create an empty user playlist, optionally inside a folder. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  inputSchema: createPlaylistInputSchema,
  outputSchema: createPlaylistOutputSchema,
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ name, folderId }) {
    return {
      playlist: {
        id: `DRYRUN_${Date.now()}`,
        name,
        ...(folderId !== undefined ? { folderId } : {}),
        isSmart: false,
        trackCount: 0,
      },
    };
  },
  async handler({ name, folderId }) {
    const input: { name: string; folderId?: string } = { name };
    if (folderId !== undefined) input.folderId = folderId;
    const playlist = await createPlaylist(input);
    return {
      structuredContent: { playlist },
      logData: { playlistId: playlist.id, hasFolderTarget: Boolean(folderId) },
    };
  },
});

export const createPlaylistFromCriteriaTool = defineTool({
  name: "music.create_playlist_from_criteria",
  description:
    "Create a playlist and add the tracks music.find_tracks would return for the same criteria.\nRequires APPLE_MUSIC_MCP_ENABLE_WRITES=true. Bulk adds are not atomic; check the returned ID lists.",
  inputSchema: createPlaylistFromCriteriaInputSchema,
  outputSchema: createPlaylistFromCriteriaOutputSchema,
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ name, folderId }) {
    return {
      playlist: {
        id: `DRYRUN_${Date.now()}`,
        name,
        ...(folderId !== undefined ? { folderId } : {}),
        isSmart: false,
        trackCount: 0,
      },
      matched: 0,
      requested: 0,
      added: 0,
      addedTrackIds: [],
      missingTrackIds: [],
      failedTrackIds: [],
      scanned: 0,
      truncated: false,
    };
  },
  async handler({ name, folderId, criteria }) {
    const tracks = await findTracks(criteria);
    const createInput: { name: string; folderId?: string } = { name };
    if (folderId !== undefined) createInput.folderId = folderId;
    const playlist = await createPlaylist(createInput);
    const addResult: AddTracksResult =
      tracks.tracks.length === 0
        ? {
            playlistId: playlist.id,
            requested: 0,
            added: 0,
            addedTrackIds: [],
            missingTrackIds: [],
            failedTrackIds: [],
          }
        : await addTracksToPlaylist(
            playlist.id,
            tracks.tracks.map((track) => track.id),
          );

    return {
      structuredContent: {
        playlist: {
          ...playlist,
          trackCount: addResult.added,
        },
        matched: tracks.totalMatched,
        requested: addResult.requested,
        added: addResult.added,
        addedTrackIds: addResult.addedTrackIds,
        missingTrackIds: addResult.missingTrackIds,
        failedTrackIds: addResult.failedTrackIds,
        scanned: tracks.scanned,
        truncated: tracks.truncated,
      },
      logData: {
        playlistId: playlist.id,
        matched: tracks.totalMatched,
        requested: addResult.requested,
        added: addResult.added,
        missingCount: addResult.missingTrackIds.length,
        failedCount: addResult.failedTrackIds.length,
        scanned: tracks.scanned,
        truncated: tracks.truncated,
      },
    };
  },
});

async function listPlaylists(input: {
  folderId?: string;
  includeRoot?: boolean;
}): Promise<Playlist[]> {
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 60 seconds
            set playlistRows to {}
            set allPlaylists to every user playlist
            repeat with p in allPlaylists
                try
                    set playlistId to persistent ID of p as text
                    set playlistName to name of p as text

                    set parentFolderId to ""
                    try
                        set parentFolderId to persistent ID of (parent of p) as text
                    on error
                        set parentFolderId to ""
                    end try

                    set smartValue to "false"
                    try
                        if (special kind of p) is not none then
                            set smartValue to "true"
                        end if
                    end try
                    if smartValue is "false" then
                        try
                            if smart of p then
                                set smartValue to "true"
                            end if
                        end try
                    end if

                    -- Avoid expensive per-playlist track counting in list operations.
                    set trackCountValue to "-1"

                    set end of playlistRows to {playlistId, playlistName, parentFolderId, smartValue, trackCountValue}
                end try
            end repeat

            return my jsonPlaylists(playlistRows)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonPlaylists(rows)
    set json to "["
    repeat with i from 1 to (count of rows)
        set row to item i of rows
        set playlistId to item 1 of row
        set playlistName to item 2 of row
        set parentFolderId to item 3 of row
        set smartValue to item 4 of row
        set trackCountValue to item 5 of row
        set json to json & "{\\"id\\":\\"" & my jsonEscape(playlistId as text) & "\\",\\"name\\":\\"" & my jsonEscape(playlistName as text) & "\\",\\"folderId\\":\\"" & my jsonEscape(parentFolderId as text) & "\\",\\"isSmart\\":" & smartValue & ",\\"trackCount\\":" & trackCountValue & "}"
        if i < (count of rows) then
            set json to json & ","
        end if
    end repeat
    return json & "]"
end jsonPlaylists`;

  const result = await runAppleScript(buildScript(body), 70_000);

  let parsed: Array<{
    id: string;
    name: string;
    folderId: string;
    isSmart: boolean;
    trackCount: number;
  }>;
  try {
    parsed = JSON.parse(result.stdout) as Array<{
      id: string;
      name: string;
      folderId: string;
      isSmart: boolean;
      trackCount: number;
    }>;
  } catch {
    throw new MusicToolError("script_error", "Music returned an invalid playlist payload.", {
      outputLength: result.stdout.length,
    });
  }

  // Deduplicate by persistent ID
  const seen = new Set<string>();
  const deduped = parsed.filter((p) => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });

  const includeRoot = input.includeRoot ?? true;
  const filtered = deduped.filter((playlist) => {
    const parentId = playlist.folderId.trim();
    if (input.folderId) return parentId === input.folderId;
    if (!includeRoot) return parentId.length > 0;
    return true;
  });

  return filtered.map((playlist) => {
    const output: Playlist = {
      id: playlist.id,
      name: playlist.name,
      isSmart: Boolean(playlist.isSmart),
    };
    const folderId = playlist.folderId.trim();
    if (folderId.length > 0) output.folderId = folderId;
    if (Number.isFinite(playlist.trackCount) && playlist.trackCount >= 0) {
      output.trackCount = playlist.trackCount;
    }
    return output;
  });
}

async function createPlaylist(input: { name: string; folderId?: string }): Promise<Playlist> {
  const safeName = escapeAppleScriptString(input.name);
  const safeFolderId = escapeAppleScriptString(input.folderId ?? "");
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set newPlaylist to make new user playlist with properties {name: "${safeName}"}

            if "${safeFolderId}" is not "" then
                set targetFolder to first folder playlist whose persistent ID is "${safeFolderId}"
                move newPlaylist to targetFolder
            end if

            set parentFolderId to ""
            try
                set parentFolderId to persistent ID of (parent of newPlaylist) as text
            on error
                set parentFolderId to ""
            end try

            return my jsonPlaylist((persistent ID of newPlaylist as text), (name of newPlaylist as text), parentFolderId)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonPlaylist(playlistId, playlistName, parentFolderId)
    return "{\\"id\\":\\"" & my jsonEscape(playlistId) & "\\",\\"name\\":\\"" & my jsonEscape(playlistName) & "\\",\\"folderId\\":\\"" & my jsonEscape(parentFolderId) & "\\",\\"isSmart\\":false,\\"trackCount\\":0}"
end jsonPlaylist`;

  const result = await runAppleScript(buildScript(body), 40_000);

  let parsed: { id: string; name: string; folderId: string; isSmart: boolean; trackCount: number };
  try {
    parsed = JSON.parse(result.stdout) as {
      id: string;
      name: string;
      folderId: string;
      isSmart: boolean;
      trackCount: number;
    };
  } catch {
    throw new MusicToolError("script_error", "Music returned an invalid create playlist payload.", {
      outputLength: result.stdout.length,
    });
  }

  const output: Playlist = {
    id: parsed.id,
    name: parsed.name,
    isSmart: false,
    trackCount: 0,
  };
  const folderId = parsed.folderId.trim();
  if (folderId.length > 0) output.folderId = folderId;
  return output;
}
