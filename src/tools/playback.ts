import * as z from "zod/v4";
import { runAppleScript } from "../applescript/runner.js";
import { buildScript, buildRawScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import type { NowPlaying } from "../types.js";
import type { ToolDef } from "../server.js";

export const getNowPlayingTool: ToolDef = {
    name: "music.get_now_playing",
    description: "Get the currently playing track: name, artist, album, duration, position, and player state.",
    inputSchema: {},
    outputSchema: {
        name: z.string(),
        artist: z.string(),
        album: z.string(),
        duration: z.number(),
        position: z.number(),
        playerState: z.enum(["playing", "paused", "stopped"]),
    },
    writesRequired: false,
    async handler() {
        const nowPlaying = await getNowPlaying();
        return { structuredContent: nowPlaying };
    },
};

export const playbackControlTool: ToolDef = {
    name: "music.playback_control",
    description: "Control Apple Music playback: play, pause, next, previous, or toggle play/pause.",
    inputSchema: {
        action: z.enum(["play", "pause", "next", "previous", "toggle"]),
    },
    outputSchema: {
        success: z.boolean(),
        action: z.string(),
        playerState: z.enum(["playing", "paused", "stopped"]),
    },
    writesRequired: true,
    dryRunResult({ action }: { action: "play" | "pause" | "next" | "previous" | "toggle" }) {
        const playerState = action === "pause" ? "paused" : "playing";
        return {
            success: true,
            action,
            playerState,
        };
    },
    async handler({ action }: { action: "play" | "pause" | "next" | "previous" | "toggle" }) {
        const result = await controlPlayback(action);
        return { structuredContent: result, logData: { action } };
    },
};

async function getNowPlaying(): Promise<NowPlaying> {
    const script = buildRawScript(`
try
    if application "Music" is not running then
        return "{\\"playerState\\":\\"stopped\\",\\"name\\":\\"\\",\\"artist\\":\\"\\",\\"album\\":\\"\\",\\"duration\\":0,\\"position\\":0}"
    end if
end try

tell application "Music"
    set pState to player state as text
    if pState is "stopped" then
        return "{\\"playerState\\":\\"stopped\\",\\"name\\":\\"\\",\\"artist\\":\\"\\",\\"album\\":\\"\\",\\"duration\\":0,\\"position\\":0}"
    end if

    set trackName to name of current track as text
    set trackArtist to artist of current track as text
    set trackAlbum to album of current track as text
    set trackDuration to duration of current track
    set trackPosition to player position

    set stateStr to "playing"
    if pState is "paused" then
        set stateStr to "paused"
    end if

    return "{\\"playerState\\":\\"" & stateStr & "\\",\\"name\\":\\"" & my jsonEscape(trackName) & "\\",\\"artist\\":\\"" & my jsonEscape(trackArtist) & "\\",\\"album\\":\\"" & my jsonEscape(trackAlbum) & "\\",\\"duration\\":" & trackDuration & ",\\"position\\":" & trackPosition & "}"
end tell

on jsonEscape(sourceText)
    set bs to (ASCII character 92)
    set sourceText to my replaceText(bs, bs & bs, sourceText)
    set sourceText to my replaceText(quote, bs & quote, sourceText)
    set sourceText to my replaceText(return, "\\n", sourceText)
    set sourceText to my replaceText(linefeed, "\\n", sourceText)
    set sourceText to my replaceText(tab, "\\t", sourceText)
    return sourceText
end jsonEscape

on replaceText(findText, replaceText, sourceText)
    set tid to AppleScript's text item delimiters
    set AppleScript's text item delimiters to findText
    set textItems to text items of sourceText
    set AppleScript's text item delimiters to replaceText
    set sourceText to textItems as text
    set AppleScript's text item delimiters to tid
    return sourceText
end replaceText
`);

    const result = await runAppleScript(script, 10_000);

    let parsed: NowPlaying;
    try {
        parsed = JSON.parse(result.stdout) as NowPlaying;
    } catch {
        throw new MusicToolError("script_error", "Music returned an invalid now playing payload.", {
            raw: result.stdout,
        });
    }
    return parsed;
}

async function controlPlayback(
    action: "play" | "pause" | "next" | "previous" | "toggle",
): Promise<{ success: boolean; action: string; playerState: "playing" | "paused" | "stopped" }> {
    const actionMap: Record<string, string> = {
        play: "play",
        pause: "pause",
        next: "next track",
        previous: "previous track",
        toggle: "playpause",
    };

    const asAction = actionMap[action] ?? "playpause";

    const script = buildScript(`
try
    tell application id "com.apple.Music"
        ${asAction}
        delay 0.2
        set pState to player state as text
        set stateStr to "stopped"
        if pState is "playing" then
            set stateStr to "playing"
        else if pState is "paused" then
            set stateStr to "paused"
        end if
        return "{\\"success\\":true,\\"action\\":\\"${action}\\",\\"playerState\\":\\"" & stateStr & "\\"}"
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`);

    const result = await runAppleScript(script, 15_000);

    let parsed: { success: boolean; action: string; playerState: "playing" | "paused" | "stopped" };
    try {
        parsed = JSON.parse(result.stdout) as { success: boolean; action: string; playerState: "playing" | "paused" | "stopped" };
    } catch {
        throw new MusicToolError("script_error", "Music returned an invalid playback control payload.", {
            raw: result.stdout,
        });
    }
    return parsed;
}
