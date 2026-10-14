import * as z from "zod/v4";

import { toJavaScriptLiteral } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runJavaScript } from '../applescript/runner.js';
import type { ExecFn } from '../applescript/runner.js';
import { buildJavaScript } from "../applescript/templates.js";

const playlistEntrySchema = z.object({
  id: z.string(),
  isSmart: z.boolean(),
  kind: z.enum(["user", "folder"]),
  name: z.string(),
});
export type PlaylistEntry = z.output<typeof playlistEntrySchema>;

/** List user playlists and folders. One `properties` read returns every column from one snapshot. */
export async function readPlaylistEntries(
  execFn: ExecFn | undefined
): Promise<PlaylistEntry[]> {
  const body = `
const KINDS = { userPlaylist: "user", folderPlaylist: "folder" };
JSON.stringify(music.playlists.properties().flatMap((p) => {
    const kind = KINDS[p.class];
    if (kind === undefined) return [];
    return [{ id: p.persistentID, name: p.name, kind, isSmart: p.specialKind !== "none" || p.smart === true }];
}));`;
  const result = await runJavaScript(buildJavaScript(body), 60_000, execFn);
  return parseAppleScriptJson(
    result.stdout,
    z.array(playlistEntrySchema),
    "Music returned an invalid playlist payload."
  );
}

// Music has no bulk read for parent, and each Apple Event takes about 17 ms. Separate osascript
// processes run in parallel: on 499 playlists, 4 processes cut 8.3 s to 2.4 s and 8 only to 1.6 s.
const PARENT_READ_PROCESSES = 4;
const MIN_IDS_PER_PROCESS = 25;

/** Read each playlist's parent folder ID. Top-level playlists map to "". */
export async function readParentIds(
  ids: string[],
  execFn: ExecFn | undefined
): Promise<Map<string, string>> {
  const processes = Math.min(
    PARENT_READ_PROCESSES,
    Math.ceil(ids.length / MIN_IDS_PER_PROCESS)
  );
  const chunkSize = Math.ceil(ids.length / Math.max(processes, 1));
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += chunkSize) {
    chunks.push(ids.slice(start, start + chunkSize));
  }
  const parents = (
    await Promise.all(chunks.map( async (chunk) => readParentChunk(chunk, execFn)))
  ).flat();
  return new Map(ids.map((id, index) => [id, parents[index] ?? ""]));
}

async function readParentChunk(
  ids: string[],
  execFn: ExecFn | undefined
): Promise<string[]> {
  // -1728 means the playlist has no parent, or was deleted after the listing; both read as top level.
  const body = `
const playlists = music.playlists;
JSON.stringify(${toJavaScriptLiteral(ids)}.map((id) => {
    try {
        return playlists.whose({ persistentID: id })[0].parent.persistentID();
    } catch (error) {
        if (error.errorNumber === -1728) return "";
        throw error;
    }
}));`;
  const result = await runJavaScript(buildJavaScript(body), 60_000, execFn);
  return parseAppleScriptJson(
    result.stdout,
    z.array(z.string()).length(ids.length),
    "Music returned an invalid playlist parent payload."
  );
}
