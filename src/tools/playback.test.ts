import { describe, expect, test } from "bun:test";
import { MusicToolError } from "../types.js";
import { createPlaybackOperations, playTool, setPlayerTool } from "./playback.js";

function recordingRunner(stdout: string) {
  const scripts: string[] = [];
  const run = async (script: string) => {
    scripts.push(script);
    return { stdout, stderr: "" };
  };
  return { scripts, operations: createPlaybackOperations(run) };
}

const PLAYING_PAYLOAD = JSON.stringify({
  found: true,
  playerState: "playing",
  track: { id: "AAAABBBBCCCCDDDD", name: "Song", artist: "Artist", album: "Album" },
});

describe("music.play input", () => {
  test("requires exactly one of playlistId or trackId", () => {
    const schema = playTool.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({ playlistId: "ABCDEF1234567890", trackId: "AAAABBBBCCCCDDDD" }).success,
    ).toBe(false);
    expect(schema.safeParse({ playlistId: "ABCDEF1234567890" }).success).toBe(true);
    expect(schema.safeParse({ trackId: "AAAABBBBCCCCDDDD", shuffle: false }).success).toBe(true);
  });
});

describe("createPlaybackOperations.play", () => {
  test("plays a playlist found by ID and reports the current track", async () => {
    const { scripts, operations } = recordingRunner(PLAYING_PAYLOAD);
    const result = await operations.play({ kind: "playlist", id: "ABCDEF1234567890" }, undefined);
    expect(result).toEqual({
      playerState: "playing",
      track: { id: "AAAABBBBCCCCDDDD", name: "Song", artist: "Artist", album: "Album" },
    });
    expect(scripts[0]).toContain('every playlist whose persistent ID is "ABCDEF1234567890"');
    expect(scripts[0]).not.toContain("set shuffle enabled");
  });

  test("looks tracks up in the library and sets shuffle before playing", async () => {
    const { scripts, operations } = recordingRunner(PLAYING_PAYLOAD);
    await operations.play({ kind: "track", id: "AAAABBBBCCCCDDDD" }, true);
    const script = scripts[0] ?? "";
    expect(script).toContain(
      'every track of library playlist 1 whose persistent ID is "AAAABBBBCCCCDDDD"',
    );
    expect(script.indexOf("set shuffle enabled to true")).toBeGreaterThan(-1);
    expect(script.indexOf("set shuffle enabled to true")).toBeLessThan(
      script.indexOf("play (item 1 of matches)"),
    );
  });

  test("escapes the ID it interpolates", async () => {
    const { scripts, operations } = recordingRunner(PLAYING_PAYLOAD);
    await operations.play({ kind: "playlist", id: 'X" & (do shell script "id") & "' }, undefined);
    expect(scripts[0]).toContain('persistent ID is "X\\" & (do shell script \\"id\\") & \\""');
  });

  test("maps a missing ID to not_found and other states to stopped", async () => {
    const missing = recordingRunner('{"found":false}').operations;
    const error = await missing
      .play({ kind: "track", id: "AAAABBBBCCCCDDDD" }, undefined)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MusicToolError);
    expect((error as MusicToolError).code).toBe("not_found");

    const rewinding = recordingRunner('{"found":true,"playerState":"rewinding","track":null}');
    expect(
      await rewinding.operations.play({ kind: "playlist", id: "ABCDEF1234567890" }, undefined),
    ).toEqual({ playerState: "stopped", track: null });
  });
});

describe("music.set_player input", () => {
  test("requires at least one setting and bounds each value", () => {
    const schema = setPlayerTool.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ volume: 101 }).success).toBe(false);
    expect(schema.safeParse({ volume: 50.5 }).success).toBe(false);
    expect(schema.safeParse({ position: -1 }).success).toBe(false);
    expect(schema.safeParse({ repeat: "shuffle" }).success).toBe(false);
    expect(schema.safeParse({ repeat: "one" }).success).toBe(true);
  });
});

describe("createPlaybackOperations.setPlayer", () => {
  const STATUS =
    '{"ok":true,"volume":40,"shuffle":true,"repeat":"all","position":12.5,"playerState":"paused"}';

  test("writes only the given settings and returns the read-back status", async () => {
    const { scripts, operations } = recordingRunner(STATUS);
    const status = await operations.setPlayer({ volume: 40, repeat: "all" });
    expect(status).toEqual({
      volume: 40,
      shuffle: true,
      repeat: "all",
      position: 12.5,
      playerState: "paused",
    });
    const script = scripts[0] ?? "";
    expect(script).toContain("set sound volume to 40");
    expect(script).toContain("set song repeat to all");
    expect(script).not.toContain("set shuffle enabled");
    expect(script).not.toContain("set player position");
    expect(script).not.toContain('"stopped" then return');
  });

  test("guards a seek against a stopped player before writing anything", async () => {
    const { scripts, operations } = recordingRunner('{"ok":false}');
    const error = await operations
      .setPlayer({ volume: 10, position: 30 })
      .catch((caught: unknown) => caught);
    expect((error as MusicToolError).code).toBe("validation_error");
    const script = scripts[0] ?? "";
    expect(script).toContain("set player position to 30.000");
    expect(script.indexOf('"stopped" then return')).toBeLessThan(
      script.indexOf("set sound volume to 10"),
    );
  });
});
