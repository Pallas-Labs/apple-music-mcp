import { describe, expect, test } from "bun:test";

import { MusicToolError } from "../types.js";
import {
  createPlaybackOperations,
  playTool,
  setPlayerTool,
} from "./playback.js";

function recordingRunner(stdout: string) {
  const scripts: string[] = [];
  const run = async (script: string) => {
    scripts.push(script);
    return { stdout, stderr: "" };
  };
  return { scripts, operations: createPlaybackOperations(run) };
}

async function errorOf(promise: Promise<unknown>): Promise<MusicToolError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(MusicToolError);
  return error as MusicToolError;
}

const TRACK = {
  id: "AAAABBBBCCCCDDDD",
  name: "Song",
  artist: "Artist",
  album: "Album",
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
      schema.safeParse({ trackId: "AAAABBBBCCCCDDDD", shuffle: false }).success
    ).toBe(true);
  });
});

describe("createPlaybackOperations.play", () => {
  test("reports the player state and the track now playing", async () => {
    const { operations } = recordingRunner(PLAYING_PAYLOAD);
    for (const kind of ["playlist", "track"] as const) {
      expect(
        await operations.play({ kind, id: "ABCDEF1234567890" }, undefined)
      ).toEqual({
        playerState: "playing",
        track: TRACK,
      });
    }
  });

  test("sets shuffle before it starts playback", async () => {
    const { scripts, operations } = recordingRunner(PLAYING_PAYLOAD);
    await operations.play({ kind: "track", id: "AAAABBBBCCCCDDDD" }, true);
    const script = scripts[0] ?? "";
    expect(script.indexOf("set shuffle enabled to true")).toBeGreaterThan(-1);
    expect(script.indexOf("set shuffle enabled to true")).toBeLessThan(
      script.indexOf("play (item 1 of matches)")
    );
  });

  test("escapes the ID it interpolates", async () => {
    const { scripts, operations } = recordingRunner(PLAYING_PAYLOAD);
    await operations.play(
      { kind: "playlist", id: 'X" & (do shell script "id") & "' },
      undefined
    );
    expect(scripts[0]).toContain(
      'persistent ID is "X\\" & (do shell script \\"id\\") & \\""'
    );
  });

  test("maps a missing ID to not_found and other states to stopped", async () => {
    const missing = recordingRunner('{"found":false}').operations;
    const error = await errorOf(
      missing.play({ kind: "track", id: "AAAABBBBCCCCDDDD" }, undefined)
    );
    expect(error.code).toBe("not_found");
    expect(error.message).toBe("No track has the ID AAAABBBBCCCCDDDD.");

    const rewinding = recordingRunner(
      '{"found":true,"playerState":"rewinding","track":null}'
    );
    expect(
      await rewinding.operations.play(
        { kind: "playlist", id: "ABCDEF1234567890" },
        undefined
      )
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
    expect(await operations.setPlayer({ volume: 40, repeat: "all" })).toEqual({
      volume: 40,
      shuffle: true,
      repeat: "all",
      position: 12.5,
      playerState: "paused",
    });
  });

  test("refuses a seek while stopped, checking before it writes anything", async () => {
    const { scripts, operations } = recordingRunner('{"ok":false}');
    const error = await errorOf(
      operations.setPlayer({ volume: 10, position: 30 })
    );
    expect(error.code).toBe("validation_error");
    expect(error.message).toBe(
      "The player is stopped, so there is no track to seek in. Start playback first."
    );
    const script = scripts[0] ?? "";
    expect(script.indexOf('"stopped" then return')).toBeGreaterThan(-1);
    expect(script.indexOf('"stopped" then return')).toBeLessThan(
      script.indexOf("set sound volume to 10")
    );
  });
});
