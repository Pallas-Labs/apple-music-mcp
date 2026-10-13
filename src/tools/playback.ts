import * as z from "zod/v4";
import { persistentIdSchema } from "../config.js";
import { escapeAppleScriptString } from "../applescript/escape.js";
import { parseAppleScriptJson } from "../applescript/parse.js";
import { runAppleScript, type ExecFn } from "../applescript/runner.js";
import { buildScript, buildRawScript } from "../applescript/templates.js";
import { MusicToolError } from "../types.js";
import {
  ADDITIVE_WRITE_ANNOTATIONS,
  defineTool,
  IDEMPOTENT_WRITE_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  type ToolSchemaOutput,
} from "../tool-contracts.js";

const playerStateSchema = z.enum(["playing", "paused", "stopped"]);

const getNowPlayingInputSchema = z.object({});
const getNowPlayingOutputSchema = z.object({
  name: z.string().describe("Track name. Empty when stopped."),
  artist: z.string().describe("Track artist. Empty when stopped."),
  album: z.string().describe("Track album. Empty when stopped."),
  duration: z.number().describe("Track length in seconds. 0 when stopped."),
  position: z.number().describe("Playback position in seconds. 0 when stopped."),
  playerState: playerStateSchema,
});
const playbackControlInputSchema = z.object({
  action: z
    .enum(["play", "pause", "next", "previous", "toggle"])
    .describe(
      "Playback command. next and previous change tracks; toggle switches between play and pause.",
    ),
});
const playbackControlOutputSchema = z.object({
  success: z.boolean(),
  action: z.string().describe("The action that ran."),
  playerState: playerStateSchema.describe("Player state shortly after the action ran."),
});

const repeatModeSchema = z.enum(["off", "one", "all"]);

const playInputSchema = z
  .object({
    playlistId: persistentIdSchema
      .optional()
      .describe(
        "Persistent playlist ID from music.list_playlists or music.create_playlist. Give this or trackId.",
      ),
    trackId: persistentIdSchema
      .optional()
      .describe(
        "Persistent track ID from music.search_library, music.find_tracks, or music.get_playlist_tracks. Give this or playlistId.",
      ),
    shuffle: z
      .boolean()
      .optional()
      .describe("Turn shuffle on or off before playback starts. Omit to keep the current setting."),
  })
  .refine((input) => (input.playlistId === undefined) !== (input.trackId === undefined), {
    message: "Give exactly one of playlistId or trackId.",
  });
const playOutputSchema = z.object({
  playerState: playerStateSchema.describe("Player state shortly after playback started."),
  track: z
    .object({
      id: z.string().describe("Persistent track ID."),
      name: z.string(),
      artist: z.string(),
      album: z.string(),
    })
    .nullable()
    .describe("The track now in the player, or null when no track is loaded."),
});
const setPlayerInputSchema = z
  .object({
    volume: z.number().int().min(0).max(100).optional().describe("Music's output volume, 0-100."),
    shuffle: z.boolean().optional().describe("Turn shuffle on or off."),
    repeat: repeatModeSchema
      .optional()
      .describe("Repeat mode: off, one (repeat the current track), or all."),
    position: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Seek to this many seconds into the current track. Fails when the player is stopped.",
      ),
  })
  .refine(
    (input) =>
      input.volume !== undefined ||
      input.shuffle !== undefined ||
      input.repeat !== undefined ||
      input.position !== undefined,
    { message: "Give at least one of volume, shuffle, repeat, or position." },
  );
const setPlayerOutputSchema = z.object({
  volume: z.number().int().describe("Output volume, 0-100."),
  shuffle: z.boolean().describe("True when shuffle is on."),
  repeat: repeatModeSchema.describe("Repeat mode."),
  position: z.number().describe("Playback position in seconds. 0 when stopped."),
  playerState: playerStateSchema,
});

export type PlayTarget = { kind: "playlist" | "track"; id: string };
type PlayResult = ToolSchemaOutput<typeof playOutputSchema>;
export type PlayerSettings = ToolSchemaOutput<typeof setPlayerInputSchema>;
type PlayerStatus = ToolSchemaOutput<typeof setPlayerOutputSchema>;
type NowPlaying = ToolSchemaOutput<typeof getNowPlayingOutputSchema>;
type PlaybackAction = ToolSchemaOutput<typeof playbackControlInputSchema>["action"];
type PlaybackControlResult = ToolSchemaOutput<typeof playbackControlOutputSchema>;

export const getNowPlayingTool = defineTool({
  name: "music.get_now_playing",
  description:
    "Get the currently playing track: name, artist, album, duration, position, and player state.",
  inputSchema: getNowPlayingInputSchema,
  outputSchema: getNowPlayingOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
  writesRequired: false,
  async handler() {
    const nowPlaying = await playbackOperations.getNowPlaying();
    return { structuredContent: nowPlaying };
  },
});

export const playbackControlTool = defineTool({
  name: "music.playback_control",
  description:
    "Control Apple Music playback: play, pause, next, previous, or toggle. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  inputSchema: playbackControlInputSchema,
  outputSchema: playbackControlOutputSchema,
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ action }) {
    const playerState: "paused" | "playing" = action === "pause" ? "paused" : "playing";
    return {
      success: true,
      action,
      playerState,
    };
  },
  async handler({ action }) {
    const result = await playbackOperations.controlPlayback(action);
    return { structuredContent: result, logData: { action } };
  },
});

export const playTool = defineTool({
  name: "music.play",
  description:
    "Play a playlist or a library track, optionally setting shuffle first. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  inputSchema: playInputSchema,
  outputSchema: playOutputSchema,
  annotations: ADDITIVE_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult() {
    return { playerState: "playing" as const, track: null };
  },
  async handler({ playlistId, trackId, shuffle }) {
    const target: PlayTarget =
      playlistId !== undefined
        ? { kind: "playlist", id: playlistId }
        : { kind: "track", id: trackId ?? "" };
    const result = await playbackOperations.play(target, shuffle);
    return {
      structuredContent: result,
      logData: { target: target.kind, shuffle, playerState: result.playerState },
    };
  },
});

export const setPlayerTool = defineTool({
  name: "music.set_player",
  description:
    "Set volume, shuffle, repeat, or playback position and report the result. Requires APPLE_MUSIC_MCP_ENABLE_WRITES=true.",
  inputSchema: setPlayerInputSchema,
  outputSchema: setPlayerOutputSchema,
  annotations: IDEMPOTENT_WRITE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult({ volume, shuffle, repeat, position }) {
    return {
      volume: volume ?? 0,
      shuffle: shuffle ?? false,
      repeat: repeat ?? "off",
      position: position ?? 0,
      playerState: "stopped" as const,
    };
  },
  async handler(settings) {
    const status = await playbackOperations.setPlayer(settings);
    return { structuredContent: status, logData: { changed: Object.keys(settings) } };
  },
});

function toPlayerState(value: string): PlayerStatus["playerState"] {
  return value === "playing" || value === "paused" ? value : "stopped";
}

const playScriptResultSchema = z.discriminatedUnion("found", [
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    playerState: z.string(),
    track: playOutputSchema.shape.track,
  }),
]);

const setPlayerScriptResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(false) }),
  z.object({
    ok: z.literal(true),
    volume: z.number().int(),
    shuffle: z.boolean(),
    repeat: repeatModeSchema,
    position: z.number(),
    playerState: z.string(),
  }),
]);

/**
 * Read the player state into pState until `settled` holds, for at most about 0.5 seconds.
 * Music reports the old state for a moment after a command, and a slow start must still report.
 */
function waitForPlayerState(settled: string): string {
  return `repeat 10 times
                set pState to player state as text
                if ${settled} then exit repeat
                delay 0.05
            end repeat`;
}

export function buildPlayScript(target: PlayTarget, shuffle: boolean | undefined): string {
  const safeId = escapeAppleScriptString(target.id);
  const source =
    target.kind === "playlist"
      ? `every playlist whose persistent ID is "${safeId}"`
      : `every track of library playlist 1 whose persistent ID is "${safeId}"`;
  const shuffleLine = shuffle === undefined ? "" : `set shuffle enabled to ${shuffle}`;
  return buildScript(`
try
    tell application id "com.apple.Music"
        with timeout of 30 seconds
            set matches to (${source})
            if (count of matches) is 0 then return "{\\"found\\":false}"
            ${shuffleLine}
            play (item 1 of matches)
            ${waitForPlayerState('pState is "playing"')}
            set trackJson to "null"
            if pState is not "stopped" then
                try
                    set t to current track
                    set trackJson to "{\\"id\\":\\"" & my jsonEscape(persistent ID of t as text) & "\\",\\"name\\":\\"" & my jsonEscape(name of t as text) & "\\",\\"artist\\":\\"" & my jsonEscape(artist of t as text) & "\\",\\"album\\":\\"" & my jsonEscape(album of t as text) & "\\"}"
                end try
            end if
            return "{\\"found\\":true,\\"playerState\\":\\"" & pState & "\\",\\"track\\":" & trackJson & "}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`);
}

export function buildSetPlayerScript(settings: PlayerSettings): string {
  const writes = [
    settings.volume === undefined ? "" : `set sound volume to ${settings.volume}`,
    settings.shuffle === undefined ? "" : `set shuffle enabled to ${settings.shuffle}`,
    settings.repeat === undefined ? "" : `set song repeat to ${settings.repeat}`,
    settings.position === undefined ? "" : `set player position to ${settings.position.toFixed(3)}`,
  ].filter((line) => line.length > 0);
  // Checked before any write so a rejected seek leaves every setting unchanged.
  const stoppedGuard =
    settings.position === undefined
      ? ""
      : `if (player state as text) is "stopped" then return "{\\"ok\\":false}"`;
  return buildScript(`
try
    tell application id "com.apple.Music"
        with timeout of 15 seconds
            ${stoppedGuard}
            ${writes.join("\n            ")}
            set pPosition to 0
            try
                set pPosition to player position
            end try
            if pPosition is missing value then set pPosition to 0
            return "{\\"ok\\":true,\\"volume\\":" & sound volume & ",\\"shuffle\\":" & (shuffle enabled as text) & ",\\"repeat\\":\\"" & (song repeat as text) & "\\",\\"position\\":" & pPosition & ",\\"playerState\\":\\"" & (player state as text) & "\\"}"
        end timeout
    end tell
on error errMsg number errNum
    error errMsg number errNum
end try`);
}

const NOW_PLAYING_SCRIPT = buildRawScript(`
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

/** Each action's AppleScript command and the player-state condition that means it took effect. */
const PLAYBACK_COMMANDS: Record<PlaybackAction, { command: string; settled: string }> = {
  play: { command: "play", settled: 'pState is "playing"' },
  pause: { command: "pause", settled: 'pState is "paused"' },
  next: { command: "next track", settled: 'pState is "playing"' },
  previous: { command: "previous track", settled: 'pState is "playing"' },
  toggle: { command: "playpause", settled: "pState is not startState" },
};

function buildPlaybackControlScript(action: PlaybackAction): string {
  return buildScript(`
try
    tell application id "com.apple.Music"
        set startState to player state as text
        ${PLAYBACK_COMMANDS[action].command}
        ${waitForPlayerState(PLAYBACK_COMMANDS[action].settled)}
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
}

export function createPlaybackOperations(execFn?: ExecFn) {
  return {
    async getNowPlaying(): Promise<NowPlaying> {
      const result = await runAppleScript(NOW_PLAYING_SCRIPT, 10_000, execFn);
      return parseAppleScriptJson(
        result.stdout,
        getNowPlayingOutputSchema,
        "Music returned an invalid now playing payload.",
      );
    },
    async controlPlayback(action: PlaybackAction): Promise<PlaybackControlResult> {
      const result = await runAppleScript(buildPlaybackControlScript(action), 15_000, execFn);
      return parseAppleScriptJson(
        result.stdout,
        playbackControlOutputSchema,
        "Music returned an invalid playback control payload.",
      );
    },
    async play(target: PlayTarget, shuffle: boolean | undefined): Promise<PlayResult> {
      const result = await runAppleScript(buildPlayScript(target, shuffle), 40_000, execFn);
      const parsed = parseAppleScriptJson(
        result.stdout,
        playScriptResultSchema,
        "Music returned an invalid play payload.",
      );
      if (!parsed.found) {
        throw new MusicToolError("not_found", `No ${target.kind} has the ID ${target.id}.`);
      }
      return { playerState: toPlayerState(parsed.playerState), track: parsed.track };
    },
    async setPlayer(settings: PlayerSettings): Promise<PlayerStatus> {
      const result = await runAppleScript(buildSetPlayerScript(settings), 20_000, execFn);
      const parsed = parseAppleScriptJson(
        result.stdout,
        setPlayerScriptResultSchema,
        "Music returned an invalid player settings payload.",
      );
      if (!parsed.ok) {
        throw new MusicToolError(
          "validation_error",
          "The player is stopped, so there is no track to seek in. Start playback first.",
        );
      }
      return {
        volume: parsed.volume,
        shuffle: parsed.shuffle,
        repeat: parsed.repeat,
        position: parsed.position,
        playerState: toPlayerState(parsed.playerState),
      };
    },
  };
}

const playbackOperations = createPlaybackOperations();
export const getNowPlaying = playbackOperations.getNowPlaying;
