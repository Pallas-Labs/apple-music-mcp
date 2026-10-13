import * as z from "zod/v4";
import { nameSchema, persistentIdSchema } from "../config.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript } from "../applescript/runner.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Playlist } from "../types.js";
import { defineTool, IDEMPOTENT_WRITE_ANNOTATIONS } from "../tool-contracts.js";
import { playlistSchema } from "./playlists.js";

const PLAYLIST_KINDS = ["user", "folder", "subscription", "system"] as const;
type PlaylistKind = (typeof PLAYLIST_KINDS)[number];
type PlaylistEdit = "rename";

/** Why each kind of playlist refuses an edit. A kind with no entry allows that edit. */
const EDIT_REFUSALS: Record<PlaylistKind, Partial<Record<PlaylistEdit, string>>> = {
  user: {},
  folder: {},
  subscription: {
    rename: "is an Apple Music playlist saved to your library, and only its curator can rename it.",
  },
  system: {
    rename: "is a built-in playlist that Music manages, so it cannot be renamed.",
  },
};

function editableKinds(edit: PlaylistEdit): PlaylistKind[] {
  return PLAYLIST_KINDS.filter((kind) => EDIT_REFUSALS[kind][edit] === undefined);
}

function assertEditable(playlist: PlaylistInfo, edit: PlaylistEdit): void {
  const refusal = EDIT_REFUSALS[playlist.kind][edit];
  if (refusal !== undefined) {
    throw new MusicToolError("validation_error", `"${playlist.name}" ${refusal}`);
  }
}

const playlistInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(PLAYLIST_KINDS),
  isSmart: z.boolean(),
  trackCount: z.number().int(),
  folderId: z.string(),
  applied: z.boolean(),
});
type PlaylistInfo = z.output<typeof playlistInfoSchema>;

const playlistScriptResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  playlistInfoSchema.extend({ found: z.literal(true) }),
]);

const renamePlaylistInputSchema = z.object({
  playlistId: persistentIdSchema.describe(
    "Persistent playlist or folder ID from music.list_playlists, music.list_folders, music.create_playlist, or music.create_folder.",
  ),
  name: nameSchema.describe("New name, 1-255 characters."),
});
const renamePlaylistOutputSchema = z.object({ playlist: playlistSchema });

/**
 * Build a script that finds a playlist by ID, runs `edit` when the playlist's kind allows it, and
 * reports the playlist as JSON. Without an edit it only describes the playlist.
 */
export function buildPlaylistScript(
  playlistId: string,
  edit?: { kind: PlaylistEdit; statements: string },
): string {
  const safeId = escapeAppleScriptString(playlistId);
  const allowedKinds = edit
    ? `{${editableKinds(edit.kind)
        .map((kind) => `"${kind}"`)
        .join(", ")}}`
    : "{}";
  return buildScript(`
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set matches to (every playlist whose persistent ID is "${safeId}")
            if (count of matches) is 0 then return "{\\"found\\":false}"
            set p to item 1 of matches
            set pClass to class of p
            set pKind to "system"
            if pClass is folder playlist then
                set pKind to "folder"
            else if pClass is subscription playlist then
                set pKind to "subscription"
            else if pClass is user playlist then
                if special kind of p is none then set pKind to "user"
            end if
            set pId to persistent ID of p as text
            set pName to name of p as text
            set pSmart to false
            try
                set pSmart to smart of p
            end try
            set pFolderId to ""
            try
                set pFolderId to persistent ID of (parent of p) as text
            end try
            set pCount to 0
            try
                set pCount to count of tracks of p
            end try
            set applied to false
            if ${allowedKinds} contains pKind then
                ${edit?.statements ?? ""}
                set applied to true
            end if
            return "{\\"found\\":true,\\"id\\":\\"" & my jsonEscape(pId) & "\\",\\"name\\":\\"" & my jsonEscape(pName) & "\\",\\"kind\\":\\"" & pKind & "\\",\\"isSmart\\":" & (pSmart as text) & ",\\"trackCount\\":" & pCount & ",\\"folderId\\":\\"" & my jsonEscape(pFolderId) & "\\",\\"applied\\":" & (applied as text) & "}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`);
}

export function createPlaylistEditOperations(run: typeof runAppleScript = runAppleScript) {
  async function runPlaylistScript(playlistId: string, script: string): Promise<PlaylistInfo> {
    const result = await run(script, 40_000);
    const parsed = parseAppleScriptJson(
      result.stdout,
      playlistScriptResultSchema,
      "Music returned an invalid playlist payload.",
    );
    if (!parsed.found) {
      throw new MusicToolError("not_found", `No playlist has the ID ${playlistId}.`);
    }
    const { found: _found, ...info } = parsed;
    return info;
  }

  async function editPlaylist(
    playlistId: string,
    edit: PlaylistEdit,
    statements: string,
  ): Promise<PlaylistInfo> {
    const info = await runPlaylistScript(
      playlistId,
      buildPlaylistScript(playlistId, { kind: edit, statements }),
    );
    assertEditable(info, edit);
    if (!info.applied) {
      throw new MusicToolError("script_error", `Music did not ${edit} "${info.name}".`);
    }
    return info;
  }

  return {
    describe: (playlistId: string) =>
      runPlaylistScript(playlistId, buildPlaylistScript(playlistId)),
    rename: (playlistId: string, name: string) =>
      editPlaylist(
        playlistId,
        "rename",
        `set name of p to "${escapeAppleScriptString(name)}"
                set pName to name of p as text`,
      ),
  };
}

const playlistEditOperations = createPlaylistEditOperations();

function toPlaylist(info: PlaylistInfo): Playlist {
  return {
    id: info.id,
    name: info.name,
    ...(info.folderId.length > 0 ? { folderId: info.folderId } : {}),
    isSmart: info.isSmart,
    trackCount: info.trackCount,
  };
}

export const renamePlaylistTool = defineTool({
  name: "music.rename_playlist",
  description:
    "Rename a user playlist or folder. Built-in playlists are refused. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  inputSchema: renamePlaylistInputSchema,
  outputSchema: renamePlaylistOutputSchema,
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ playlistId, name }) {
    return { playlist: { id: playlistId, name, isSmart: false, trackCount: 0 } };
  },
  async handler({ playlistId, name }) {
    const playlist = toPlaylist(await playlistEditOperations.rename(playlistId, name));
    return { structuredContent: { playlist }, logData: { playlistId } };
  },
});
