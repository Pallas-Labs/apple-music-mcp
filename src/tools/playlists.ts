import * as z from "zod/v4";
import { nameSchema, persistentIdSchema } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Playlist } from "../types.js";
import type { ToolDef } from "../server.js";

export const listPlaylistsTool: ToolDef = {
  name: "music.list_playlists",
  description: "List Apple Music user playlists. Optionally filter by folder ID.",
  inputSchema: {
    folderId: persistentIdSchema.optional(),
    includeRoot: z.boolean().optional(),
  },
  outputSchema: {
    playlists: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        folderId: z.string().optional(),
        isSmart: z.boolean(),
        trackCount: z.number().optional(),
      }),
    ),
  },
  writesRequired: false,
  async handler({ folderId, includeRoot }: { folderId?: string; includeRoot?: boolean }) {
    const input: { folderId?: string; includeRoot?: boolean } = {};
    if (folderId !== undefined) input.folderId = folderId;
    if (includeRoot !== undefined) input.includeRoot = includeRoot;
    const playlists = await listPlaylists(input);
    return {
      structuredContent: { playlists },
      logData: { playlistCount: playlists.length, hasFolderFilter: Boolean(folderId) },
    };
  },
};

export const createPlaylistTool: ToolDef = {
  name: "music.create_playlist",
  description: "Create a user playlist, optionally inside a folder.",
  inputSchema: {
    name: nameSchema,
    folderId: persistentIdSchema.optional(),
  },
  outputSchema: {
    playlist: z.object({
      id: z.string(),
      name: z.string(),
      folderId: z.string().optional(),
      isSmart: z.boolean(),
      trackCount: z.number().optional(),
    }),
  },
  writesRequired: true,
  dryRunResult({ name, folderId }: { name: string; folderId?: string }) {
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
  async handler({ name, folderId }: { name: string; folderId?: string }) {
    const input: { name: string; folderId?: string } = { name };
    if (folderId !== undefined) input.folderId = folderId;
    const playlist = await createPlaylist(input);
    return {
      structuredContent: { playlist },
      logData: { playlistId: playlist.id, hasFolderTarget: Boolean(folderId) },
    };
  },
};

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
      raw: result.stdout,
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
      raw: result.stdout,
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
