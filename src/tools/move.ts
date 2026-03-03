import * as z from "zod/v4";
import { persistentIdSchema } from "../config.js";
import { runAppleScript } from "../applescript/runner.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { buildScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { Playlist } from "../types.js";
import type { ToolDef } from "../server.js";

export const movePlaylistTool: ToolDef = {
    name: "music.move_playlist",
    description: "Move a playlist into a target folder.",
    inputSchema: {
        playlistId: persistentIdSchema,
        targetFolderId: persistentIdSchema,
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
    dryRunResult({ playlistId, targetFolderId }: { playlistId: string; targetFolderId: string }) {
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
    async handler({ playlistId, targetFolderId }: { playlistId: string; targetFolderId: string }) {
        const playlist = await movePlaylist({ playlistId, targetFolderId });
        return {
            structuredContent: { playlist },
            logData: { playlistId, targetFolderId },
        };
    },
};

async function movePlaylist(input: { playlistId: string; targetFolderId: string }): Promise<Playlist> {
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

    const result = await runAppleScript(buildScript(body), 50_000);

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
        throw new MusicToolError("script_error", "Music returned an invalid move playlist payload.", {
            raw: result.stdout,
        });
    }

    const output: Playlist = {
        id: parsed.id,
        name: parsed.name,
        isSmart: Boolean(parsed.isSmart),
    };
    const folderId = parsed.folderId.trim();
    if (folderId.length > 0) output.folderId = folderId;
    if (Number.isFinite(parsed.trackCount)) output.trackCount = parsed.trackCount;
    return output;
}
