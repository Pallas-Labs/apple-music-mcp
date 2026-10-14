import * as z from "zod/v4";

import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript } from "../applescript/runner.js";
import type { ExecFn } from "../applescript/runner.js";
import { buildScript } from "../applescript/templates.js";
import { nameSchema, persistentIdSchema } from "../config.js";
import { withMutationLock } from "../mutation-lock.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  READ_ONLY_ANNOTATIONS,
} from "../tool-contracts.js";
import { readParentIds, readPlaylistEntries } from "./playlist-tree.js";
import {
  addTracksToPlaylist,
  findTracks,
  scannedOutputSchema,
  trackCriteriaSchema,
  truncatedOutputSchema,
} from "./tracks.js";
import type { AddTracksResult } from "./tracks.js";

export const playlistSchema = z.object({
  folderId: z
    .string()
    .optional()
    .describe(
      "Persistent ID of the parent folder. Omitted for top-level playlists."
    ),
  id: z.string().describe("Persistent playlist ID."),
  isSmart: z
    .boolean()
    .describe("True for smart playlists and built-in special playlists."),
  name: z.string(),
  trackCount: z
    .number()
    .optional()
    .describe(
      "Number of tracks. Omitted by music.list_playlists to keep listing fast."
    ),
});
export type Playlist = z.output<typeof playlistSchema>;
/** A playlist as the scripts print it: folderId is "" at the top level, trackCount -1 when not counted. */
export const playlistRowSchema = playlistSchema.extend({
  folderId: z.string(),
  trackCount: z.number(),
});
const listPlaylistsInputSchema = z.object({
  folderId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Returns only playlists directly inside it."
    ),
  includeRoot: z
    .boolean()
    .optional()
    .describe(
      "Include top-level playlists (default true). Ignored when folderId is set."
    ),
});
const listPlaylistsOutputSchema = z.object({
  playlists: z.array(playlistSchema),
});
const createPlaylistInputSchema = z.object({
  folderId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Omit to create at the top level."
    ),
  name: nameSchema.describe("Playlist name, 1-255 characters."),
});
const createPlaylistOutputSchema = z.object({
  playlist: playlistSchema,
});
const createPlaylistFromCriteriaInputSchema = z.object({
  criteria: trackCriteriaSchema.describe(
    "Track filters, with the same rules as music.find_tracks. At least one filter is required."
  ),
  folderId: persistentIdSchema
    .optional()
    .describe(
      "Persistent folder ID from music.list_folders or music.create_folder. Omit to create at the top level."
    ),
  name: nameSchema.describe("Playlist name, 1-255 characters."),
});
const createPlaylistFromCriteriaOutputSchema = z.object({
  added: z
    .number()
    .describe("Number of tracks added. Equals addedTrackIds.length."),
  addedTrackIds: z
    .array(z.string())
    .describe("Persistent IDs of tracks added to the playlist."),
  failedTrackIds: z
    .array(z.string())
    .describe(
      "IDs that were found in the library but could not be added to the playlist."
    ),
  matched: z
    .number()
    .describe(
      "Number of scanned tracks that matched. When truncated is true, this is a lower bound within the scanned window, not a full-library total."
    ),
  missingTrackIds: z
    .array(z.string())
    .describe(
      "IDs that were not found in the library when the server tried to add them."
    ),
  playlist: playlistSchema,
  requested: z
    .number()
    .describe(
      "Number of matched tracks the server tried to add, at most criteria.limit."
    ),
  scanned: scannedOutputSchema,
  truncated: truncatedOutputSchema,
});

export function createPlaylistOperations(execFn?: ExecFn) {
  return {
    createPlaylist: async (input: { name: string; folderId?: string }) =>
      createPlaylist(input, execFn),
    listPlaylists: async (input: {
      folderId?: string;
      includeRoot?: boolean;
    }) => listPlaylists(input, execFn),
  };
}

const playlistOperations = createPlaylistOperations();

export const listPlaylistsTool = defineTool({
  annotations: READ_ONLY_ANNOTATIONS,
  description:
    "List Apple Music user playlists with their persistent IDs, optionally only those inside one folder.",
  async handler({ folderId, includeRoot }) {
    const input: { folderId?: string; includeRoot?: boolean } = {};
    if (folderId !== undefined) input.folderId = folderId;
    if (includeRoot !== undefined) input.includeRoot = includeRoot;
    const playlists = await playlistOperations.listPlaylists(input);
    return {
      structuredContent: { playlists },
      logData: {
        playlistCount: playlists.length,
        hasFolderFilter: Boolean(folderId),
      },
    };
  },
  inputSchema: listPlaylistsInputSchema,
  name: "music.list_playlists",
  outputSchema: listPlaylistsOutputSchema,
  writesRequired: false,
});

export const createPlaylistTool = defineTool({
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  description:
    "Create an empty user playlist, optionally inside a folder. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
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
    const playlist = await playlistOperations.createPlaylist(input);
    return {
      structuredContent: { playlist },
      logData: { playlistId: playlist.id, hasFolderTarget: Boolean(folderId) },
    };
  },
  inputSchema: createPlaylistInputSchema,
  name: "music.create_playlist",
  outputSchema: createPlaylistOutputSchema,
  writesRequired: true,
});

interface CriteriaPlaylistOperations {
  findTracks: typeof findTracks;
  createPlaylist: (typeof playlistOperations)["createPlaylist"];
  addTracksToPlaylist: typeof addTracksToPlaylist;
}

export function createCriteriaPlaylistTool(
  operations: CriteriaPlaylistOperations = {
    addTracksToPlaylist,
    createPlaylist: playlistOperations.createPlaylist,
    findTracks,
  }
) {
  return defineTool({
    annotations: ADDITIVE_WRITE_ANNOTATIONS,
    description:
      "Create a playlist and add the tracks music.find_tracks would return for the same criteria.\nRequires APPLE_MUSIC_MCP_ENABLE_WRITES=true. Bulk adds are not atomic; check the returned ID lists.",
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
      // The library scan can take up to two minutes, so only the create and add hold the lock.
      const tracks = await operations.findTracks(criteria);
      const createInput: { name: string; folderId?: string } = { name };
      if (folderId !== undefined) createInput.folderId = folderId;
      const { playlist, addResult } = await withMutationLock(async () => {
        const playlist = await operations.createPlaylist(createInput);
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
            : await operations.addTracksToPlaylist(
                playlist.id,
                tracks.tracks.map((track) => track.id)
              );
        return { playlist, addResult };
      });

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
    inputSchema: createPlaylistFromCriteriaInputSchema,
    lock: "handler",
    name: "music.create_playlist_from_criteria",
    outputSchema: createPlaylistFromCriteriaOutputSchema,
    writesRequired: true,
  });
}

export const createPlaylistFromCriteriaTool = createCriteriaPlaylistTool();

async function listPlaylists(
  input: { folderId?: string; includeRoot?: boolean },
  execFn: ExecFn | undefined
): Promise<Playlist[]> {
  const playlists = (await readPlaylistEntries(execFn)).filter(
    (entry) => entry.kind === "user"
  );
  const parentIds = await readParentIds(
    playlists.map((playlist) => playlist.id),
    execFn
  );
  const includeRoot = input.includeRoot ?? true;
  return playlists.flatMap(({ id, name, isSmart }) => {
    const folderId = parentIds.get(id) ?? "";
    if (input.folderId !== undefined && folderId !== input.folderId) {
      return [];
    }
    if (input.folderId === undefined && !includeRoot && folderId === "") {
      return [];
    }
    return [{ id, isSmart, name, ...(folderId === "" ? {} : { folderId }) }];
  });
}

async function createPlaylist(
  input: { name: string; folderId?: string },
  execFn: ExecFn | undefined
): Promise<Playlist> {
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

  const result = await runAppleScript(buildScript(body), 40_000, execFn);
  const parsed = parseAppleScriptJson(
    result.stdout,
    playlistRowSchema,
    "Music returned an invalid create playlist payload."
  );

  const output: Playlist = {
    id: parsed.id,
    isSmart: false,
    name: parsed.name,
    trackCount: 0,
  };
  const folderId = parsed.folderId.trim();
  if (folderId.length > 0) {
    output.folderId = folderId;
  }
  return output;
}
