import * as z from "zod/v4";
import { persistentIdSchema } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Track } from "../types.js";
import type { ToolDef } from "../server.js";

export const getPlaylistTracksTool: ToolDef = {
    name: "music.get_playlist_tracks",
    description: "Get tracks in a playlist. Supports pagination via offset/limit.",
    inputSchema: {
        playlistId: persistentIdSchema,
        offset: z.number().int().min(0).optional().describe("Start index (default 0)."),
        limit: z.number().int().min(1).max(100).optional().describe("Max tracks to return (default 50)."),
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
        total: z.number(),
        offset: z.number(),
        limit: z.number(),
    },
    writesRequired: false,
    async handler({ playlistId, offset, limit }: { playlistId: string; offset?: number; limit?: number }) {
        const result = await getPlaylistTracks(playlistId, offset ?? 0, limit ?? 50);
        return {
            structuredContent: result,
            logData: { playlistId, trackCount: result.tracks.length, total: result.total },
        };
    },
};

export const addTracksToPlaylistTool: ToolDef = {
    name: "music.add_tracks_to_playlist",
    description: "Add tracks to a playlist by their persistent IDs.",
    inputSchema: {
        playlistId: persistentIdSchema,
        trackIds: z.array(persistentIdSchema).min(1).max(100).describe("Persistent IDs of tracks to add."),
    },
    outputSchema: {
        added: z.number(),
        playlistId: z.string(),
    },
    writesRequired: true,
    dryRunResult({ playlistId, trackIds }: { playlistId: string; trackIds: string[] }) {
        return {
            added: trackIds.length,
            playlistId,
        };
    },
    async handler({ playlistId, trackIds }: { playlistId: string; trackIds: string[] }) {
        const result = await addTracksToPlaylist(playlistId, trackIds);
        return {
            structuredContent: result,
            logData: { playlistId, addedCount: result.added },
        };
    },
};

async function getPlaylistTracks(
    playlistId: string,
    offset: number,
    limit: number,
): Promise<{ tracks: Track[]; total: number; offset: number; limit: number }> {
    const safeId = escapeAppleScriptString(playlistId);
    const body = `
try
    tell application id "com.apple.Music"
        with timeout of 60 seconds
            set targetPlaylist to first user playlist whose persistent ID is "${safeId}"
            set allTracks to tracks of targetPlaylist
            set totalCount to count of allTracks
            set trackRows to {}
            set startIdx to ${offset + 1}
            set endIdx to ${offset} + ${limit}
            if endIdx > totalCount then set endIdx to totalCount
            if startIdx > totalCount then
                return "{\\"tracks\\":[],\\"total\\":" & totalCount & ",\\"offset\\":${offset},\\"limit\\":${limit}}"
            end if
            repeat with i from startIdx to endIdx
                set t to item i of allTracks
                try
                    set trackId to persistent ID of t as text
                    set trackName to name of t as text
                    set trackArtist to artist of t as text
                    set trackAlbum to album of t as text
                    set trackDuration to duration of t
                    set end of trackRows to {trackId, trackName, trackArtist, trackAlbum, trackDuration}
                end try
            end repeat
            return "{\\"tracks\\":" & my jsonTracks(trackRows) & ",\\"total\\":" & totalCount & ",\\"offset\\":${offset},\\"limit\\":${limit}}"
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

    const result = await runAppleScript(buildScript(body), 60_000);

    let parsed: { tracks: Track[]; total: number; offset: number; limit: number };
    try {
        parsed = JSON.parse(result.stdout) as { tracks: Track[]; total: number; offset: number; limit: number };
    } catch {
        throw new MusicToolError("script_error", "Music returned an invalid playlist tracks payload.", {
            raw: result.stdout,
        });
    }
    return parsed;
}

async function addTracksToPlaylist(
    playlistId: string,
    trackIds: string[],
): Promise<{ added: number; playlistId: string }> {
    const safePlaylistId = escapeAppleScriptString(playlistId);
    // Build an AppleScript list of track IDs
    const idList = trackIds.map((id) => `"${escapeAppleScriptString(id)}"`).join(", ");
    const body = `
try
    tell application id "com.apple.Music"
        with timeout of 60 seconds
            set targetPlaylist to first user playlist whose persistent ID is "${safePlaylistId}"
            set trackIdList to {${idList}}
            set addedCount to 0
            repeat with tid in trackIdList
                try
                    set targetTrack to first track of library playlist 1 whose persistent ID is tid
                    duplicate targetTrack to targetPlaylist
                    set addedCount to addedCount + 1
                end try
            end repeat
            return "{\\"added\\":" & addedCount & ",\\"playlistId\\":\\"${safePlaylistId}\\"}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`;

    const result = await runAppleScript(buildScript(body), 60_000);

    let parsed: { added: number; playlistId: string };
    try {
        parsed = JSON.parse(result.stdout) as { added: number; playlistId: string };
    } catch {
        throw new MusicToolError("script_error", "Music returned an invalid add tracks payload.", {
            raw: result.stdout,
        });
    }
    return parsed;
}
