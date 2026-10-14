import {
  acceptedContent,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript } from "../applescript/runner.js";
import type { ExecFn } from "../applescript/runner.js";
import { buildScript } from "../applescript/templates.js";
import { nameSchema, persistentIdSchema } from "../config.js";
import {
  defineTool,
  DESTRUCTIVE_WRITE_ANNOTATIONS,
  IDEMPOTENT_WRITE_ANNOTATIONS,
} from "../tool-contracts.js";
import { MusicToolError } from "../types.js";
import { playlistSchema } from "./playlists.js";
import type { Playlist } from "./playlists.js";

const PLAYLIST_KINDS = ["user", "folder", "subscription", "system"] as const;
type PlaylistKind = (typeof PLAYLIST_KINDS)[number];
type PlaylistEdit = "rename" | "delete";

/** Why each kind of playlist refuses an edit. A kind with no entry allows that edit. */
const EDIT_REFUSALS: Record<
  PlaylistKind,
  Partial<Record<PlaylistEdit, string>>
> = {
  folder: {
    delete:
      "is a folder. Deleting a folder also deletes every playlist inside it, so delete those playlists one at a time instead.",
  },
  subscription: {
    delete:
      "is an Apple Music playlist saved to your library. Remove it from your library in Music.",
    rename:
      "is an Apple Music playlist saved to your library, and only its curator can rename it.",
  },
  system: {
    delete:
      "is a built-in playlist that Music manages, so it cannot be deleted.",
    rename:
      "is a built-in playlist that Music manages, so it cannot be renamed.",
  },
  user: {},
};

const playlistInfoSchema = z.object({
  applied: z.boolean(),
  folderId: z.string(),
  id: z.string(),
  isSmart: z.boolean(),
  kind: z.enum(PLAYLIST_KINDS),
  name: z.string(),
  trackCount: z.number().int(),
});
type PlaylistInfo = z.output<typeof playlistInfoSchema>;

const editableKinds = (edit: PlaylistEdit): PlaylistKind[] =>
  PLAYLIST_KINDS.filter((kind) => EDIT_REFUSALS[kind][edit] === undefined);

const assertEditable = (playlist: PlaylistInfo, edit: PlaylistEdit): void => {
  const refusal = EDIT_REFUSALS[playlist.kind][edit];
  if (refusal !== undefined) {
    throw new MusicToolError(
      "validation_error",
      `"${playlist.name}" ${refusal}`
    );
  }
};

const playlistScriptResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  playlistInfoSchema.extend({ found: z.literal(true) }),
]);

const renamePlaylistInputSchema = z.object({
  name: nameSchema.describe("New name, 1-255 characters."),
  playlistId: persistentIdSchema.describe(
    "Persistent playlist or folder ID from music.list_playlists, music.list_folders, music.create_playlist, or music.create_folder."
  ),
});
const renamePlaylistOutputSchema = z.object({ playlist: playlistSchema });

const deletePlaylistInputSchema = z.object({
  confirm: z
    .boolean()
    .optional()
    .describe(
      "Set true only after the user approves this deletion. Used only when the client cannot show a confirmation prompt."
    ),
  playlistId: persistentIdSchema.describe(
    "Persistent playlist ID from music.list_playlists or music.create_playlist. Folders are refused."
  ),
});
const deletePlaylistOutputSchema = z.object({
  deletedPlaylistId: z
    .string()
    .describe("Persistent ID of the deleted playlist."),
  name: z.string().describe("Name of the deleted playlist."),
});

const DELETE_CONFIRMATION_KEY = "confirmDelete";
const deleteConfirmationSchema = z.object({
  confirm: z.boolean().describe("Delete the playlist"),
});

/**
 * Build a script that finds a playlist by ID, runs `edit` when the playlist's kind allows it, and
 * reports the playlist as JSON. Without an edit it only describes the playlist.
 */
const buildPlaylistScript = (
  playlistId: string,
  edit?: { kind: PlaylistEdit; statements: string }
): string => {
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
};

export const createPlaylistEditOperations = (execFn?: ExecFn) => {
  const runPlaylistScript = async (
    playlistId: string,
    script: string
  ): Promise<PlaylistInfo> => {
    const result = await runAppleScript(script, 40_000, execFn);
    const parsed = parseAppleScriptJson(
      result.stdout,
      playlistScriptResultSchema,
      "Music returned an invalid playlist payload."
    );
    if (!parsed.found) {
      throw new MusicToolError(
        "not_found",
        `No playlist has the ID ${playlistId}.`
      );
    }
    const { found: _found, ...info } = parsed;
    return info;
  };

  const editPlaylist = async (
    playlistId: string,
    edit: PlaylistEdit,
    statements: string
  ): Promise<PlaylistInfo> => {
    const info = await runPlaylistScript(
      playlistId,
      buildPlaylistScript(playlistId, { kind: edit, statements })
    );
    assertEditable(info, edit);
    if (!info.applied) {
      throw new MusicToolError(
        "script_error",
        `Music did not ${edit} "${info.name}".`
      );
    }
    return info;
  };

  return {
    // Music sometimes answers delete with an AppleEvent timeout (-1712) after it has deleted the
    // playlist, so a timeout counts as success once the playlist is gone.
    delete: async (playlistId: string) =>
      await editPlaylist(
        playlistId,
        "delete",
        `try
                    delete p
                on error errMsg number errNum
                    if errNum is not -1712 then error errMsg number errNum
                    repeat 40 times
                        if (count of (every playlist whose persistent ID is pId)) is 0 then exit repeat
                        delay 0.25
                    end repeat
                    if (count of (every playlist whose persistent ID is pId)) is not 0 then error errMsg number errNum
                end try`
      ),
    describe: async (playlistId: string) =>
      await runPlaylistScript(playlistId, buildPlaylistScript(playlistId)),
    rename: async (playlistId: string, name: string) =>
      await editPlaylist(
        playlistId,
        "rename",
        `set name of p to "${escapeAppleScriptString(name)}"
                set pName to name of p as text`
      ),
  };
};

type PlaylistEditOperations = ReturnType<typeof createPlaylistEditOperations>;

const playlistEditOperations = createPlaylistEditOperations();

const describeTracks = (count: number): string =>
  count === 1 ? "1 track" : `${count} tracks`;

const toPlaylist = (info: PlaylistInfo): Playlist => {
  const playlist: Playlist = {
    id: info.id,
    isSmart: info.isSmart,
    name: info.name,
    trackCount: info.trackCount,
  };
  if (info.folderId.length > 0) {
    playlist.folderId = info.folderId;
  }
  return playlist;
};

export const renamePlaylistTool = defineTool({
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  description:
    "Rename a user playlist or folder. Built-in playlists are refused. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  dryRunResult({ playlistId, name }) {
    return {
      playlist: { id: playlistId, isSmart: false, name, trackCount: 0 },
    };
  },
  async handler({ playlistId, name }) {
    const playlist = toPlaylist(
      await playlistEditOperations.rename(playlistId, name)
    );
    return { logData: { playlistId }, structuredContent: { playlist } };
  },
  inputSchema: renamePlaylistInputSchema,
  name: "music.rename_playlist",
  outputSchema: renamePlaylistOutputSchema,
  writesRequired: true,
});

export const createDeletePlaylistTool = (
  operations: PlaylistEditOperations = playlistEditOperations
) =>
  defineTool({
    annotations: DESTRUCTIVE_WRITE_ANNOTATIONS,
    description:
      "Delete a user playlist after the user confirms. Folders are refused. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.\nClients that support elicitation always show a confirmation prompt; other clients must pass confirm: true.",
    dryRunResult({ playlistId }) {
      return { deletedPlaylistId: playlistId, name: "DRY_RUN_PLAYLIST" };
    },
    async handler({ playlistId, confirm }, { canElicit, inputResponses }) {
      const confirmationPending = canElicit
        ? inputResponse(inputResponses, DELETE_CONFIRMATION_KEY).kind ===
          "missing"
        : confirm !== true;

      if (confirmationPending) {
        const playlist = await operations.describe(playlistId);
        assertEditable(playlist, "delete");
        const summary = `"${playlist.name}" (${describeTracks(playlist.trackCount)})`;
        if (!canElicit) {
          throw new MusicToolError(
            "validation_error",
            `This client cannot show a confirmation prompt. Ask the user to approve deleting ${summary}, then call again with confirm: true.`
          );
        }
        return inputRequired({
          inputRequests: {
            [DELETE_CONFIRMATION_KEY]: inputRequired.elicit({
              message: `Delete the playlist ${summary}? Its tracks stay in your library. This cannot be undone.`,
              requestedSchema: deleteConfirmationSchema,
            }),
          },
        });
      }

      if (canElicit) {
        const answer = acceptedContent(
          inputResponses,
          DELETE_CONFIRMATION_KEY,
          deleteConfirmationSchema
        );
        if (answer?.confirm !== true) {
          throw new MusicToolError(
            "validation_error",
            "Deletion cancelled. Nothing was deleted."
          );
        }
      }

      const deleted = await operations.delete(playlistId);
      return {
        logData: {
          confirmedBy: canElicit ? "elicitation" : "argument",
          playlistId,
          trackCount: deleted.trackCount,
        },
        structuredContent: {
          deletedPlaylistId: deleted.id,
          name: deleted.name,
        },
      };
    },
    inputSchema: deletePlaylistInputSchema,
    name: "music.delete_playlist",
    outputSchema: deletePlaylistOutputSchema,
    writesRequired: true,
  });

export const deletePlaylistTool = createDeletePlaylistTool();
