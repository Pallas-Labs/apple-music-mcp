import * as z from "zod/v4";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Track } from "../types.js";
import type { ToolDef } from "../server.js";

export const searchLibraryTool: ToolDef = {
    name: "music.search_library",
    description: "Search the Apple Music library for tracks by name or artist. Returns up to 50 results.",
    inputSchema: {
        query: z.string().trim().min(1).max(255).describe("Search query (matches track name or artist)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 50)."),
    },
    outputSchema: {
        tracks: z.array(
            z.object({
                id: z.string(),
                name: z.string(),
                artist: z.string(),
                album: z.string(),
                duration: z.number(),
            }),
        ),
    },
    writesRequired: false,
    async handler({ query, limit }: { query: string; limit?: number }) {
        const tracks = await searchLibrary(query, limit ?? 50);
        return { structuredContent: { tracks }, logData: { query, resultCount: tracks.length } };
    },
};

async function searchLibrary(query: string, limit: number): Promise<Track[]> {
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

    const result = await runAppleScript(buildScript(body), 30_000);

    let parsed: Track[];
    try {
        parsed = JSON.parse(result.stdout) as Track[];
    } catch {
        throw new MusicToolError("script_error", "Music returned an invalid search payload.", {
            raw: result.stdout,
        });
    }
    return parsed;
}
