import { describe, expect, test } from "bun:test";
import vm from "node:vm";
import {
  FIND_TRACKS_CANDIDATE_CAP,
  createTrackOperations,
  matchesTrackCriteria,
  pickFindTracksPrefilter,
} from "./tracks.js";
import type { ExecFn, ScriptLanguage } from "../applescript/runner.js";
import type { LibraryTrack } from "../types.js";

const sampleTrack: LibraryTrack = {
  id: "ABCDEF1234567890",
  name: "I Never Party in Paris",
  artist: "LB aka LABAT",
  album: "Feel So Good Around U",
  genre: "Electronic",
  duration: 197.052001953125,
  year: 2024,
  playCount: 7,
};

function trackColumns(tracks: LibraryTrack[]): Record<string, unknown[]> {
  return {
    persistentID: tracks.map((track) => track.id),
    name: tracks.map((track) => track.name),
    artist: tracks.map((track) => track.artist),
    album: tracks.map((track) => track.album),
    genre: tracks.map((track) => track.genre),
    duration: tracks.map((track) => track.duration),
    year: tracks.map((track) => track.year),
    playCount: tracks.map((track) => track.playCount),
  };
}

type ScriptCall = { language: ScriptLanguage; whoseArgument: unknown };

/**
 * An exec that runs the generated JXA against a fake Music library. The library answers every
 * whose clause with the given columns, and throws on property reads of an empty result as Music
 * does.
 */
function fakeMusicExec(columns: Record<string, unknown[]>): { exec: ExecFn; calls: ScriptCall[] } {
  const calls: ScriptCall[] = [];
  const count = columns["persistentID"]?.length ?? 0;
  const collection: Record<string, unknown> = { length: count };
  for (const [name, values] of Object.entries(columns)) {
    collection[name === "playCount" ? "playedCount" : name] = () => {
      if (count === 0) throw new Error("Can't get object.");
      return values;
    };
  }
  const exec: ExecFn = async (script, _timeoutMs, language) => {
    const call: ScriptCall = { language, whoseArgument: "whose not called" };
    calls.push(call);
    const tracks = {
      ...collection,
      whose: (argument: unknown) => {
        call.whoseArgument = argument;
        return collection;
      },
    };
    const Application = () => ({
      running: () => true,
      launch: () => undefined,
      libraryPlaylists: [{ tracks }],
    });
    const stdout = vm.runInNewContext(script, { Application, delay: () => undefined });
    return { stdout, stderr: "" };
  };
  return { exec, calls };
}

describe("pickFindTracksPrefilter", () => {
  test("prefers the longest text criterion", () => {
    expect(
      pickFindTracksPrefilter({
        nameQuery: "Paris",
        artist: "LB aka LABAT",
        album: "Feel So Good Around U",
        yearMin: 2000,
      }),
    ).toEqual({ property: "album", operator: "_contains", value: "Feel So Good Around U" });
  });

  test("maps numeric bounds to inclusive comparisons", () => {
    expect(pickFindTracksPrefilter({ yearMax: 2010 })).toEqual({
      property: "year",
      operator: "_lessThanEquals",
      value: 2010,
    });
    expect(pickFindTracksPrefilter({ yearMin: 2000 })).toEqual({
      property: "year",
      operator: "_greaterThanEquals",
      value: 2000,
    });
    expect(pickFindTracksPrefilter({ playCountMin: 5 })).toEqual({
      property: "playedCount",
      operator: "_greaterThanEquals",
      value: 5,
    });
    expect(pickFindTracksPrefilter({ playCountMax: 3 })).toEqual({
      property: "playedCount",
      operator: "_lessThanEquals",
      value: 3,
    });
  });

  test("returns undefined when no criteria are present", () => {
    expect(pickFindTracksPrefilter({})).toBeUndefined();
  });
});

describe("matchesTrackCriteria", () => {
  test("matches text criteria case-insensitively", () => {
    expect(
      matchesTrackCriteria(sampleTrack, {
        nameQuery: "party in paris",
        artist: "labat",
        album: "feel so good",
        genre: "electronic",
      }),
    ).toBe(true);
  });

  test("rejects tracks outside numeric bounds", () => {
    expect(
      matchesTrackCriteria(sampleTrack, {
        yearMin: 2025,
      }),
    ).toBe(false);

    expect(
      matchesTrackCriteria(sampleTrack, {
        playCountMax: 3,
      }),
    ).toBe(false);
  });
});

describe("createTrackOperations.findTracks", () => {
  test("rejects missing and reversed criteria before invoking a script", async () => {
    const { exec, calls } = fakeMusicExec(trackColumns([]));
    const operations = createTrackOperations(exec);

    await expect(operations.findTracks({})).rejects.toThrow(
      "At least one track filter is required.",
    );
    await expect(operations.findTracks({ yearMin: 2025, yearMax: 2020 })).rejects.toThrow(
      "yearMin must be less than or equal to yearMax.",
    );
    await expect(operations.findTracks({ playCountMin: 10, playCountMax: 2 })).rejects.toThrow(
      "playCountMin must be less than or equal to playCountMax.",
    );
    expect(calls).toHaveLength(0);
  });

  test("asks Music for the text filter and reads matching rows column by column", async () => {
    const tracks = [
      { ...sampleTrack, id: "TRACK00000000001", name: "Love Lost", year: 2001, playCount: 1 },
      { ...sampleTrack, id: "TRACK00000000002", name: "Glove", year: 2002, playCount: 9 },
    ];
    const { exec, calls } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({ nameQuery: "love", playCountMin: 0 });
    expect(calls).toEqual([
      { language: "JavaScript", whoseArgument: { name: { _contains: "love" } } },
    ]);
    expect(result).toEqual({
      tracks: [tracks[1]!, tracks[0]!],
      totalMatched: 2,
      limit: 50,
      scanned: 2,
      truncated: false,
    });
  });

  test("asks Music for a numeric bound when no text filter is present", async () => {
    const { exec, calls } = fakeMusicExec(trackColumns([]));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({ yearMin: 2000, yearMax: 2010 });
    expect(calls[0]!.whoseArgument).toEqual({ year: { _lessThanEquals: 2010 } });
    expect(result).toEqual({
      tracks: [],
      totalMatched: 0,
      limit: 50,
      scanned: 0,
      truncated: false,
    });
  });

  test("delivers hostile filter text to Music unchanged", async () => {
    const { exec, calls } = fakeMusicExec(trackColumns([]));
    const operations = createTrackOperations(exec);
    const hostile = `a"b\\c\nd${String.fromCharCode(0x2028)}e\`); throw new Error("pwned"); (\``;

    await operations.findTracks({ artist: hostile });
    expect(calls[0]!.whoseArgument).toEqual({ artist: { _contains: hostile } });
  });

  test("applies the filters Music did not evaluate, then sorts and limits", async () => {
    const tracks = [
      { ...sampleTrack, id: "TRACK00000000001", artist: "Skeler", year: 1999, playCount: 5 },
      { ...sampleTrack, id: "TRACK00000000002", artist: "Skeler", year: 2005, playCount: 3 },
      { ...sampleTrack, id: "TRACK00000000003", artist: "Skeler", year: 2005, playCount: 8 },
      { ...sampleTrack, id: "TRACK00000000004", artist: "Skeler", year: 2007, playCount: 6 },
    ];
    const { exec } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({
      artist: "skeler",
      yearMin: 2000,
      sortBy: "playCount",
      limit: 2,
    });
    expect(result.tracks.map((track) => track.id)).toEqual([
      "TRACK00000000003",
      "TRACK00000000004",
    ]);
    expect(result.totalMatched).toBe(3);
    expect(result.scanned).toBe(4);
    expect(result.truncated).toBe(false);
  });

  test("stops reading at the safety cap and reports truncation", async () => {
    const tracks = Array.from({ length: FIND_TRACKS_CANDIDATE_CAP + 3 }, (_, index) => ({
      ...sampleTrack,
      id: `TRACK${index.toString().padStart(11, "0")}`,
      playCount: index,
    }));
    const { exec } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({ playCountMin: 0, sortBy: "playCount", limit: 1 });
    expect(result.scanned).toBe(FIND_TRACKS_CANDIDATE_CAP);
    expect(result.truncated).toBe(true);
    expect(result.totalMatched).toBe(FIND_TRACKS_CANDIDATE_CAP);
    expect(result.tracks[0]!.playCount).toBe(FIND_TRACKS_CANDIDATE_CAP - 1);
  });

  test("fails when Music returns columns of different lengths", async () => {
    const columns = trackColumns([sampleTrack, { ...sampleTrack, id: "TRACK00000000002" }]);
    columns["year"] = [2024];
    const { exec } = fakeMusicExec(columns);
    const operations = createTrackOperations(exec);

    await expect(operations.findTracks({ yearMin: 2000 })).rejects.toMatchObject({
      code: "script_error",
    });
  });

  test("rejects schema-invalid script payloads", async () => {
    const operations = createTrackOperations(async () => ({
      stdout: JSON.stringify({ tracks: "not-an-array", scanned: 1, truncated: false }),
      stderr: "",
    }));

    await expect(operations.findTracks({ yearMin: 2000 })).rejects.toMatchObject({
      code: "script_error",
    });
  });
});

describe("createTrackOperations mutations", () => {
  test("returns add success, missing, and duplicate-failure classifications", async () => {
    const operations = createTrackOperations(async () => ({
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 3,
        added: 1,
        addedTrackIds: ["TRACK00000000001"],
        missingTrackIds: ["TRACK00000000002"],
        failedTrackIds: ["TRACK00000000003"],
      }),
      stderr: "",
    }));

    await expect(
      operations.addTracksToPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
        "TRACK00000000003",
      ]),
    ).resolves.toEqual({
      playlistId: "PLAYLIST12345678",
      requested: 3,
      added: 1,
      addedTrackIds: ["TRACK00000000001"],
      missingTrackIds: ["TRACK00000000002"],
      failedTrackIds: ["TRACK00000000003"],
    });
  });

  test("rejects inconsistent add counts", async () => {
    const operations = createTrackOperations(async () => ({
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 2,
        added: 1,
        addedTrackIds: ["TRACK00000000001"],
        missingTrackIds: [],
        failedTrackIds: [],
      }),
      stderr: "",
    }));

    await expect(
      operations.addTracksToPlaylist("PLAYLIST12345678", ["TRACK00000000001", "TRACK00000000002"]),
    ).rejects.toMatchObject({ code: "script_error" });
  });

  test("returns removal instances, missing IDs, and failed deletes", async () => {
    const operations = createTrackOperations(async () => ({
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 4,
        removed: 3,
        removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
        missingTrackIds: ["TRACK00000000004"],
        failedTrackIds: ["TRACK00000000002", "TRACK00000000003"],
      }),
      stderr: "",
    }));

    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
        "TRACK00000000003",
        "TRACK00000000004",
      ]),
    ).resolves.toEqual({
      playlistId: "PLAYLIST12345678",
      requested: 4,
      removed: 3,
      removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
      missingTrackIds: ["TRACK00000000004"],
      failedTrackIds: ["TRACK00000000002", "TRACK00000000003"],
    });
  });

  test("rejects classifications that do not match the request", async () => {
    const addOperations = createTrackOperations(async () => ({
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 2,
        added: 1,
        addedTrackIds: ["TRACK00000000001"],
        missingTrackIds: ["TRACK00000000009"],
        failedTrackIds: [],
      }),
      stderr: "",
    }));
    await expect(
      addOperations.addTracksToPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
      ]),
    ).rejects.toMatchObject({ code: "script_error" });

    const removeOperations = createTrackOperations(async () => ({
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 2,
        removed: 1,
        removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
        missingTrackIds: [],
        failedTrackIds: [],
      }),
      stderr: "",
    }));
    await expect(
      removeOperations.removeTracksFromPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
      ]),
    ).rejects.toMatchObject({ code: "script_error" });
  });
  test("rejects duplicate IDs before invoking AppleScript", async () => {
    let invocations = 0;
    const operations = createTrackOperations(async () => {
      invocations += 1;
      return { stdout: "{}", stderr: "" };
    });

    await expect(
      operations.addTracksToPlaylist("PLAYLIST12345678", ["TRACK00000000001", "TRACK00000000001"]),
    ).rejects.toThrow("Track IDs must be unique.");
    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000001",
      ]),
    ).rejects.toThrow("Track IDs must be unique.");
    expect(invocations).toBe(0);
  });
});
