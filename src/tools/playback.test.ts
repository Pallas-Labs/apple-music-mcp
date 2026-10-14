import { describe, expect, mock, test } from "bun:test";
import type { Mock } from "bun:test";

import type { ExecFn } from "../applescript/runner.js";
import { MusicToolError } from "../types.js";
import {
  createPlaybackOperations,
  playTool,
  setPlayerTool,
} from "./playback.js";

const recordingRunner = (stdout: string) => {
  const run = mock<ExecFn>().mockResolvedValue({ stderr: "", stdout });
  return { operations: createPlaybackOperations(run), run };
};

const firstScript = (run: Mock<ExecFn>): string => run.mock.calls[0]?.[0] ?? "";

const errorOf = async <T>(promise: Promise<T>): Promise<MusicToolError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MusicToolError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the promise to reject with a MusicToolError.");
};

const TRACK = {
  album: "Album",
  artist: "Artist",
  id: "AAAABBBBCCCCDDDD",
  name: "Song",
};
const PLAYING_PAYLOAD = JSON.stringify({
  found: true,
  playerState: "playing",
  track: TRACK,
});

describe("music.play input", () => {
  test("requires exactly one of playlistId or trackId", () => {
    const schema = playTool.inputSchema;
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({
        playlistId: "ABCDEF1234567890",
        trackId: "AAAABBBBCCCCDDDD",
      }).success
    ).toBe(false);
    expect(schema.safeParse({ playlistId: "ABCDEF1234567890" }).success).toBe(
      true
    );
    expect(
      schema.safeParse({ shuffle: false, trackId: "AAAABBBBCCCCDDDD" }).success
    ).toBe(true);
  });
});

describe("createPlaybackOperations.play", () => {
  test("reports the player state and the track now playing", async () => {
    const { operations } = recordingRunner(PLAYING_PAYLOAD);
    const results = await Promise.all(
      (["playlist", "track"] as const).map(
        async (kind) => await operations.play({ id: "ABCDEF1234567890", kind })
      )
    );
    expect(results).toEqual([
      { playerState: "playing", track: TRACK },
      { playerState: "playing", track: TRACK },
    ]);
  });

  test("sets shuffle before it starts playback", async () => {
    const { run, operations } = recordingRunner(PLAYING_PAYLOAD);
    await operations.play({ id: "AAAABBBBCCCCDDDD", kind: "track" }, true);
    const script = firstScript(run);
    expect(script.indexOf("set shuffle enabled to true")).toBeGreaterThan(-1);
    expect(script.indexOf("set shuffle enabled to true")).toBeLessThan(
      script.indexOf("play (item 1 of matches)")
    );
  });

  test("escapes the ID it interpolates", async () => {
    const { run, operations } = recordingRunner(PLAYING_PAYLOAD);
    await operations.play({
      id: 'X" & (do shell script "id") & "',
      kind: "playlist",
    });
    expect(firstScript(run)).toContain(
      'persistent ID is "X\\" & (do shell script \\"id\\") & \\""'
    );
  });

  test("maps a missing ID to not_found and other states to stopped", async () => {
    const missing = recordingRunner('{"found":false}').operations;
    const error = await errorOf(
      missing.play({ id: "AAAABBBBCCCCDDDD", kind: "track" })
    );
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("No track has the ID AAAABBBBCCCCDDDD.");

    const rewinding = recordingRunner(
      '{"found":true,"playerState":"rewinding","track":null}'
    );
    expect(
      await rewinding.operations.play({
        id: "ABCDEF1234567890",
        kind: "playlist",
      })
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
  test("returns the status Music reports after the writes", async () => {
    const { operations } = recordingRunner(
      '{"ok":true,"volume":40,"shuffle":true,"repeat":"all","position":12.5,"playerState":"paused"}'
    );
    expect(await operations.setPlayer({ repeat: "all", volume: 40 })).toEqual({
      playerState: "paused",
      position: 12.5,
      repeat: "all",
      shuffle: true,
      volume: 40,
    });
  });

  test("refuses a seek while stopped, checking before it writes anything", async () => {
    const { run, operations } = recordingRunner('{"ok":false}');
    const error = await errorOf(
      operations.setPlayer({ position: 30, volume: 10 })
    );
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe(
      "The player is stopped, so there is no track to seek in. Start playback first."
    );
    const script = firstScript(run);
    expect(script.indexOf('"stopped" then return')).toBeGreaterThan(-1);
    expect(script.indexOf('"stopped" then return')).toBeLessThan(
      script.indexOf("set sound volume to 10")
    );
  });
});
