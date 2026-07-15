import { describe, expect, test } from "bun:test";
import {
  FIND_TRACKS_CANDIDATE_CAP,
  createTrackOperations,
  matchesTrackCriteria,
  pickTrackSearchSeed,
} from "./tracks.js";
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

describe("pickTrackSearchSeed", () => {
  test("prefers the longest text criterion", () => {
    expect(
      pickTrackSearchSeed({
        nameQuery: "Paris",
        artist: "LB aka LABAT",
        album: "Feel So Good Around U",
      }),
    ).toBe("Feel So Good Around U");
  });

  test("returns undefined when no text criteria are present", () => {
    expect(
      pickTrackSearchSeed({
        yearMin: 2020,
        playCountMin: 5,
      }),
    ).toBeUndefined();
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
  test("rejects missing and reversed criteria before invoking AppleScript", async () => {
    let invocations = 0;
    const operations = createTrackOperations(async () => {
      invocations += 1;
      return { stdout: '{"tracks":[],"scanned":0,"truncated":false}', stderr: "" };
    });

    await expect(operations.findTracks({})).rejects.toThrow(
      "At least one track filter is required.",
    );
    await expect(operations.findTracks({ yearMin: 2025, yearMax: 2020 })).rejects.toThrow(
      "yearMin must be less than or equal to yearMax.",
    );
    await expect(operations.findTracks({ playCountMin: 10, playCountMax: 2 })).rejects.toThrow(
      "playCountMin must be less than or equal to playCountMax.",
    );
    expect(invocations).toBe(0);
  });

  test("uses the capped full-library path for numeric-only criteria", async () => {
    let script = "";
    const operations = createTrackOperations(async (generatedScript) => {
      script = generatedScript;
      return { stdout: '{"tracks":[],"scanned":0,"truncated":false}', stderr: "" };
    });

    const result = await operations.findTracks({ yearMin: 2000 });
    expect(script).toContain("set sourceTracks to tracks of library playlist 1");
    expect(script).toContain(`if scannedCount > ${FIND_TRACKS_CANDIDATE_CAP}`);
    expect(script).toContain('if "" is not ""');
    expect(result).toEqual({
      tracks: [],
      totalMatched: 0,
      limit: 50,
      scanned: 0,
      truncated: false,
    });
  });

  test("filters, sorts, limits, and preserves a truncated 1,000-track window", async () => {
    const tracks = Array.from({ length: FIND_TRACKS_CANDIDATE_CAP }, (_, index) => ({
      ...sampleTrack,
      id: `TRACK${index.toString().padStart(11, "0")}`,
      name: `Track ${index}`,
      playCount: index,
    }));
    const operations = createTrackOperations(async () => ({
      stdout: JSON.stringify({
        tracks,
        scanned: FIND_TRACKS_CANDIDATE_CAP,
        truncated: true,
      }),
      stderr: "",
    }));

    const result = await operations.findTracks({
      playCountMin: 997,
      sortBy: "playCount",
      limit: 2,
    });
    expect(result.tracks.map((track) => track.playCount)).toEqual([999, 998]);
    expect(result.totalMatched).toBe(3);
    expect(result.scanned).toBe(FIND_TRACKS_CANDIDATE_CAP);
    expect(result.truncated).toBe(true);
  });

  test("rejects schema-invalid AppleScript payloads", async () => {
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
