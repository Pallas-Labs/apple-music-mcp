import * as z from "zod/v4";

import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript } from '../applescript/runner.js';
import type { ExecFn } from '../applescript/runner.js';
import { buildScript } from "../applescript/templates.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from '../tool-contracts.js';
import type { ToolSchemaOutput } from '../tool-contracts.js';
import { durationOutputSchema, trackIdOutputSchema } from "./tracks.js";

const searchLibraryInputSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Maximum results, 1-50 (default 50)."),
  query: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .describe(
      "Search text, 1-255 characters. Uses the Music app's library search."
    ),
});
const searchLibraryOutputSchema = z.object({
  tracks: z.array(
    z.object({
      album: z.string(),
      artist: z.string(),
      duration: durationOutputSchema,
      id: trackIdOutputSchema,
      name: z.string(),
    })
  ),
});

export const searchLibraryTool = defineTool({
  annotations: READ_ONLY_ANNOTATIONS,
  description:
    "Search the Apple Music library for tracks by text and return up to 50 matches with persistent IDs.",
  async handler({ query, limit }) {
    const tracks = await searchOperations.searchLibrary(query, limit ?? 50);
    return {
      structuredContent: { tracks },
      logData: { query, resultCount: tracks.length },
    };
  },
  inputSchema: searchLibraryInputSchema,
  name: "music.search_library",
  outputSchema: searchLibraryOutputSchema,
  writesRequired: false,
});

type SearchResult = ToolSchemaOutput<
  typeof searchLibraryOutputSchema
>["tracks"];

async function searchLibrary(
  query: string,
  limit: number,
  execFn: ExecFn | undefined
): Promise<SearchResult> {
  const safeQuery = escapeAppleScriptString(query);
  const body = `
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set searchResults to (search library playlist 1 for "${safeQuery}" only all)
            set trackRows to {}
            set maxCount to ${limit}
            set currentCount to 0
            repeat with t in searchResults
                if currentCount >= maxCount then exit repeat
                try
                    set trackId to persistent ID of t as text
                    set trackName to name of t as text
                    set trackArtist to artist of t as text
                    set trackAlbum to album of t as text
                    set trackDuration to duration of t
                    set end of trackRows to {trackId, trackName, trackArtist, trackAlbum, trackDuration}
                    set currentCount to currentCount + 1
                end try
            end repeat
            return my jsonTracks(trackRows)
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try

on jsonTracks(rows)
    set json to "["
    repeat with i from 1 to (count of rows)
        set row to item i of rows
        set tId to item 1 of row
        set tName to item 2 of row
        set tArtist to item 3 of row
        set tAlbum to item 4 of row
        set tDuration to item 5 of row
        set json to json & "{\\"id\\":\\"" & my jsonEscape(tId as text) & "\\",\\"name\\":\\"" & my jsonEscape(tName as text) & "\\",\\"artist\\":\\"" & my jsonEscape(tArtist as text) & "\\",\\"album\\":\\"" & my jsonEscape(tAlbum as text) & "\\",\\"duration\\":" & tDuration & "}"
        if i < (count of rows) then
            set json to json & ","
        end if
    end repeat
    return json & "]"
end jsonTracks`;

  const result = await runAppleScript(buildScript(body), 30_000, execFn);
  return parseAppleScriptJson(
    result.stdout,
    searchLibraryOutputSchema.shape.tracks,
    "Music returned an invalid search payload."
  );
}

export function createSearchOperations(execFn?: ExecFn) {
  return {
    searchLibrary:  async (query: string, limit: number) =>
      searchLibrary(query, limit, execFn),
  };
}

const searchOperations = createSearchOperations();
