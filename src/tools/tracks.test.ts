import { describe, expect, test } from "bun:test";
import vm from "node:vm";

import type { ExecFn, ScriptLanguage } from "../applescript/runner.js";
import type { LibraryTrack } from "../types.js";
import {
  FIND_TRACKS_CANDIDATE_CAP,
  createTrackOperations,
  matchesTrackCriteria,
  pickFindTracksPrefilter,
} from "./tracks.js";

const sampleTrack: LibraryTrack = {
  album: "Feel So Good Around U",
  artist: "LB aka LABAT",
  duration: 197.052001953125,
  genre: "Electronic",
  id: "ABCDEF1234567890",
  name: "I Never Party in Paris",
  playCount: 7,
  year: 2024,
};

function trackColumns(tracks: LibraryTrack[]): Record<string, unknown[]> {
  return {
    album: tracks.map((track) => track.album),
    artist: tracks.map((track) => track.artist),
    duration: tracks.map((track) => track.duration),
    genre: tracks.map((track) => track.genre),
    name: tracks.map((track) => track.name),
    persistentID: tracks.map((track) => track.id),
    playCount: tracks.map((track) => track.playCount),
    year: tracks.map((track) => track.year),
  };
}

interface ScriptCall {
  language: ScriptLanguage;
  whoseArgument: unknown;
}

/**
 * An exec that runs the generated JXA against a fake Music library. The library answers every
 * whose clause with the given columns, and throws on property reads of an empty result as Music
 * does.
 */
function fakeMusicExec(columns: Record<string, unknown[]>): {
  exec: ExecFn;
  calls: ScriptCall[];
} {
  const calls: ScriptCall[] = [];
  const count = columns.persistentID?.length ?? 0;
  const collection: Record<string, unknown> = { length: count };
  for (const [name, values] of Object.entries(columns)) {
    collection[name === "playCount" ? "playedCount" : name] = () => {
      if (count === 0) {
        throw new Error("Can't get object.");
      }
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
      launch: () => undefined,
      libraryPlaylists: [{ tracks }],
      running: () => true,
    });
    const stdout = vm.runInNewContext(script, {
      Application,
      delay: () => {},
    });
    return { stderr: "", stdout };
  };
  return { calls, exec };
}

interface FakeMusicOptions {
  library: LibraryTrack[];
  playlist?: { id: string; tracks: LibraryTrack[] };
  /** Track IDs whose duplicate into the playlist fails. */
  failDuplicate?: string[];
  /** Zero-based playlist positions whose delete fails. */
  failDeleteAt?: number[];
}

const MUSIC_NOT_FOUND = "Can't get object. (-1728)";

/**
 * An exec that runs generated JXA against an in-memory Music. It models what the scripts rely
 * on: bulk column reads, byId specifiers, inclusive `slice` ranges that throw past the end, and
 * -1728 on property reads of an empty whose result. Returns the playlist's live entries so tests
 * can assert on the end state.
 */
function fakeMusic(options: FakeMusicOptions): {
  exec: ExecFn;
  playlistTracks: LibraryTrack[];
} {
  const playlistTracks = [...(options.playlist?.tracks ?? [])];
  // Each playlist entry carries its own database ID in Music, distinct from the library track's.
  const entryIds = playlistTracks.map((_, index) => 1000 + index);
  let nextEntryId = 1000 + playlistTracks.length;
  const failDuplicate = new Set(options.failDuplicate ?? []);
  const failDeleteAt = new Set(options.failDeleteAt ?? []);
  const libraryDatabaseId = (track: LibraryTrack) =>
    options.library.indexOf(track) + 1;

  type Kind = "library" | "playlist";
  interface Spec {
    kind: Kind;
    index: number;
  }
  const columns: Record<
    string,
    (track: LibraryTrack, index: number, kind: Kind) => unknown
  > = {
    album: (track) => track.album,
    artist: (track) => track.artist,
    duration: (track) => track.duration,
    genre: (track) => track.genre,
    id: (track, index, kind) =>
      kind === "library" ? libraryDatabaseId(track) : entryIds[index],
    name: (track) => track.name,
    persistentID: (track) => track.id,
    playedCount: (track) => track.playCount,
    year: (track) => track.year,
  };

  /** One element specifier: a handle for duplicate/delete that also reads its own properties. */
  function element(kind: Kind, tracks: () => LibraryTrack[], index: number) {
    const spec: Record<string, unknown> & Spec = { index, kind };
    for (const [name, read] of Object.entries(columns)) {
      spec[name] = () => {
        const track = tracks()[index];
        if (!track) {
          throw new Error(MUSIC_NOT_FOUND);
        }
        return read(track, index, kind);
      };
    }
    return spec;
  }

  function collection(kind: Kind, tracks: () => LibraryTrack[]) {
    const target: Record<string | symbol, unknown> = {
      byId: (databaseId: number) => {
        const index =
          kind === "library"
            ? options.library.findIndex(
                (track) => libraryDatabaseId(track) === databaseId
              )
            : entryIds.indexOf(databaseId);
        if (index < 0 || index >= tracks().length) {
          throw new Error(MUSIC_NOT_FOUND);
        }
        return element(kind, tracks, index);
      },
      slice: (start: number, end: number) => {
        if (start < 0 || end >= tracks().length) {
          throw new Error("Message not understood.");
        }
        const range = tracks().slice(start, end + 1);
        return collection(kind, () => (range.length === 1 ? [] : range));
      },
    };
    for (const [name, read] of Object.entries(columns)) {
      target[name] = () => {
        if (tracks().length === 0) {
          throw new Error(MUSIC_NOT_FOUND);
        }
        return tracks().map((track, index) => read(track, index, kind));
      };
    }
    return new Proxy(target, {
      get(object, property) {
        if (property === "length") {
          return tracks().length;
        }
        if (typeof property === "string" && /^\d+$/.test(property)) {
          return element(kind, tracks, Number(property));
        }
        return object[property];
      },
    });
  }

  const libraryTracks = collection("library", () => options.library);
  const playlistCollection = collection("playlist", () => playlistTracks);
  const playlistObject = { id: () => 7, tracks: playlistCollection };
  const music = {
    delete: (spec: Spec) => {
      if (spec.kind !== "playlist" || spec.index >= playlistTracks.length) {
        throw new Error(MUSIC_NOT_FOUND);
      }
      if (failDeleteAt.has(spec.index))
        throw new Error("Music got an error: Can't delete.");
      playlistTracks.splice(spec.index, 1);
      entryIds.splice(spec.index, 1);
    },
    duplicate: (spec: Spec, { to }: { to: unknown }) => {
      const track = options.library[spec.index];
      if (
        spec.kind !== "library" ||
        !track ||
        to !== playlistObject ||
        failDuplicate.has(track.id)
      ) {
        throw new Error(
          "Music got an error: Can't make or move that element into that container."
        );
      }
      playlistTracks.push(track);
      entryIds.push(nextEntryId);
      nextEntryId += 1;
    },
    launch: () => undefined,
    libraryPlaylists: [{ tracks: libraryTracks }],
    running: () => true,
    userPlaylists: {
      byId: (databaseId: number) => {
        if (databaseId !== 7) throw new Error(MUSIC_NOT_FOUND);
        return playlistObject;
      },
      whose: (argument: { persistentID: string }) =>
        options.playlist &&
        options.playlist.id.toUpperCase() ===
          argument.persistentID.toUpperCase()
          ? [playlistObject]
          : [
              {
                id: () => {
                  throw new Error(MUSIC_NOT_FOUND);
                },
              },
            ],
    },
  };

  const exec: ExecFn = async (script, _timeoutMs, language) => {
    expect(language).toBe("JavaScript");
    try {
      const stdout = vm.runInNewContext(script, {
        Application: () => music,
        delay: () => {},
      });
      return { stderr: "", stdout: String(stdout) };
    } catch (error) {
      // osascript reports script errors on stderr with the Apple error number in parentheses.
      throw Object.assign(new Error("osascript failed"), {
        stderr: `execution error: Error: ${(error as Error).message}`,
      });
    }
  };
  return { exec, playlistTracks };
}

function libraryOf(count: number): LibraryTrack[] {
  return Array.from({ length: count }, (_, index) => ({
    ...sampleTrack,
    id: `TRACK${index.toString().padStart(11, "0")}`,
    name: `Track ${index}`,
  }));
}

describe("pickFindTracksPrefilter", () => {
  test("prefers the longest text criterion", () => {
    expect(
      pickFindTracksPrefilter({
        album: "Feel So Good Around U",
        artist: "LB aka LABAT",
        nameQuery: "Paris",
        yearMin: 2000,
      })
    ).toEqual({
      operator: "_contains",
      property: "album",
      value: "Feel So Good Around U",
    });
  });

  test("maps numeric bounds to inclusive comparisons", () => {
    expect(pickFindTracksPrefilter({ yearMax: 2010 })).toEqual({
      operator: "_lessThanEquals",
      property: "year",
      value: 2010,
    });
    expect(pickFindTracksPrefilter({ yearMin: 2000 })).toEqual({
      operator: "_greaterThanEquals",
      property: "year",
      value: 2000,
    });
    expect(pickFindTracksPrefilter({ playCountMin: 5 })).toEqual({
      operator: "_greaterThanEquals",
      property: "playedCount",
      value: 5,
    });
    expect(pickFindTracksPrefilter({ playCountMax: 3 })).toEqual({
      operator: "_lessThanEquals",
      property: "playedCount",
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
        album: "feel so good",
        artist: "labat",
        genre: "electronic",
        nameQuery: "party in paris",
      })
    ).toBe(true);
  });

  test("rejects tracks outside numeric bounds", () => {
    expect(
      matchesTrackCriteria(sampleTrack, {
        yearMin: 2025,
      })
    ).toBe(false);

    expect(
      matchesTrackCriteria(sampleTrack, {
        playCountMax: 3,
      })
    ).toBe(false);
  });
});

describe("createTrackOperations.findTracks", () => {
  test("rejects missing and reversed criteria before invoking a script", async () => {
    const { exec, calls } = fakeMusicExec(trackColumns([]));
    const operations = createTrackOperations(exec);

    await expect(operations.findTracks({})).rejects.toThrow(
      "At least one track filter is required."
    );
    await expect(
      operations.findTracks({ yearMax: 2020, yearMin: 2025 })
    ).rejects.toThrow("yearMin must be less than or equal to yearMax.");
    await expect(
      operations.findTracks({ playCountMax: 2, playCountMin: 10 })
    ).rejects.toThrow(
      "playCountMin must be less than or equal to playCountMax."
    );
    expect(calls).toHaveLength(0);
  });

  test("asks Music for the text filter and reads matching rows column by column", async () => {
    const tracks = [
      {
        ...sampleTrack,
        id: "TRACK00000000001",
        name: "Love Lost",
        playCount: 1,
        year: 2001,
      },
      {
        ...sampleTrack,
        id: "TRACK00000000002",
        name: "Glove",
        playCount: 9,
        year: 2002,
      },
    ];
    const { exec, calls } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({
      nameQuery: "love",
      playCountMin: 0,
    });
    expect(calls).toEqual([
      {
        language: "JavaScript",
        whoseArgument: { name: { _contains: "love" } },
      },
    ]);
    expect(result).toEqual({
      limit: 50,
      scanned: 2,
      totalMatched: 2,
      tracks: [tracks[1]!, tracks[0]!],
      truncated: false,
    });
  });

  test("asks Music for a numeric bound when no text filter is present", async () => {
    const { exec, calls } = fakeMusicExec(trackColumns([]));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({
      yearMax: 2010,
      yearMin: 2000,
    });
    expect(calls[0]!.whoseArgument).toEqual({
      year: { _lessThanEquals: 2010 },
    });
    expect(result).toEqual({
      limit: 50,
      scanned: 0,
      totalMatched: 0,
      tracks: [],
      truncated: false,
    });
  });

  test("delivers hostile filter text to Music unchanged", async () => {
    const { exec, calls } = fakeMusicExec(trackColumns([]));
    const operations = createTrackOperations(exec);
    const hostile = `a"b\\c\nd${String.fromCharCode(0x20_28)}e\`); throw new Error("pwned"); (\``;

    await operations.findTracks({ artist: hostile });
    expect(calls[0]!.whoseArgument).toEqual({ artist: { _contains: hostile } });
  });

  test("applies the filters Music did not evaluate, then sorts and limits", async () => {
    const tracks = [
      {
        ...sampleTrack,
        artist: "Skeler",
        id: "TRACK00000000001",
        playCount: 5,
        year: 1999,
      },
      {
        ...sampleTrack,
        artist: "Skeler",
        id: "TRACK00000000002",
        playCount: 3,
        year: 2005,
      },
      {
        ...sampleTrack,
        artist: "Skeler",
        id: "TRACK00000000003",
        playCount: 8,
        year: 2005,
      },
      {
        ...sampleTrack,
        artist: "Skeler",
        id: "TRACK00000000004",
        playCount: 6,
        year: 2007,
      },
    ];
    const { exec } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({
      artist: "skeler",
      limit: 2,
      sortBy: "playCount",
      yearMin: 2000,
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
    const tracks = Array.from(
      { length: FIND_TRACKS_CANDIDATE_CAP + 3 },
      (_, index) => ({
        ...sampleTrack,
        id: `TRACK${index.toString().padStart(11, "0")}`,
        playCount: index,
      })
    );
    const { exec } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({
      limit: 1,
      playCountMin: 0,
      sortBy: "playCount",
    });
    expect(result.scanned).toBe(FIND_TRACKS_CANDIDATE_CAP);
    expect(result.truncated).toBe(true);
    expect(result.totalMatched).toBe(FIND_TRACKS_CANDIDATE_CAP);
    expect(result.tracks[0]!.playCount).toBe(FIND_TRACKS_CANDIDATE_CAP - 1);
  });

  test("fails when Music returns columns of different lengths", async () => {
    const columns = trackColumns([
      sampleTrack,
      { ...sampleTrack, id: "TRACK00000000002" },
    ]);
    columns.year = [2024];
    const { exec } = fakeMusicExec(columns);
    const operations = createTrackOperations(exec);

    await expect(
      operations.findTracks({ yearMin: 2000 })
    ).rejects.toMatchObject({
      code: "script_error",
    });
  });

  test("rejects schema-invalid script payloads", async () => {
    const validColumns = {
      albums: ["B"],
      artists: ["A"],
      durations: [1.5],
      genres: ["C"],
      ids: ["TRACK00000000001"],
      names: ["Love"],
      playCounts: [3],
      years: [2001],
    };
    const payloads: unknown[] = [
      { scanned: 1, tracks: "not-an-array", truncated: false },
      {
        columns: { ...validColumns, years: ["2001"] },
        scanned: 1,
        truncated: false,
      },
      { columns: { ...validColumns, names: [] }, scanned: 1, truncated: false },
      { columns: validColumns, scanned: 2, truncated: false },
      { columns: validColumns, scanned: 1, truncated: "no" },
      "not json",
    ];
    for (const payload of payloads) {
      const operations = createTrackOperations(async () => ({
        stderr: "",
        stdout: typeof payload === "string" ? payload : JSON.stringify(payload),
      }));
      await expect(
        operations.findTracks({ yearMin: 2000 })
      ).rejects.toMatchObject({
        code: "script_error",
      });
    }

    const operations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        columns: validColumns,
        scanned: 1,
        truncated: false,
      }),
    }));
    await expect(
      operations.findTracks({ yearMin: 2000 })
    ).resolves.toMatchObject({
      totalMatched: 1,
      tracks: [
        { id: "TRACK00000000001", name: "Love", year: 2001, playCount: 3 },
      ],
    });
  });

  test("matches text filters without regard to case or Unicode line terminators", async () => {
    const tracks = [
      {
        ...sampleTrack,
        artist: "Mixed Case",
        id: "TRACK00000000001",
        name: "ÉLAN VITAL",
      },
      {
        ...sampleTrack,
        artist: "mixed case",
        id: "TRACK00000000002",
        name: "elan",
      },
    ];
    const { exec } = fakeMusicExec(trackColumns(tracks));
    const operations = createTrackOperations(exec);

    const result = await operations.findTracks({
      artist: "MIXED",
      nameQuery: "élan",
    });
    expect(result.tracks.map((track) => track.id)).toEqual([
      "TRACK00000000001",
    ]);
  });
});

describe("createTrackOperations.getPlaylistTracks", () => {
  const library = libraryOf(5);
  const page = (track: LibraryTrack) => ({
    album: track.album,
    artist: track.artist,
    duration: track.duration,
    id: track.id,
    name: track.name,
  });

  test("returns the requested page with the playlist total", async () => {
    const { exec } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: library },
    });
    const operations = createTrackOperations(exec);

    await expect(
      operations.getPlaylistTracks("playlist12345678", 1, 2)
    ).resolves.toEqual({
      limit: 2,
      offset: 1,
      total: 5,
      tracks: [page(library[1]!), page(library[2]!)],
    });
  });

  test("returns a final page holding a single track", async () => {
    const { exec } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: library },
    });
    const operations = createTrackOperations(exec);

    await expect(
      operations.getPlaylistTracks("PLAYLIST12345678", 4, 10)
    ).resolves.toEqual({
      limit: 10,
      offset: 4,
      total: 5,
      tracks: [page(library[4]!)],
    });
  });

  test("returns an empty page past the end and for an empty playlist", async () => {
    const full = createTrackOperations(
      fakeMusic({
        library,
        playlist: { id: "PLAYLIST12345678", tracks: library },
      }).exec
    );
    await expect(
      full.getPlaylistTracks("PLAYLIST12345678", 5, 50)
    ).resolves.toEqual({
      limit: 50,
      offset: 5,
      total: 5,
      tracks: [],
    });

    const empty = createTrackOperations(
      fakeMusic({ library, playlist: { id: "PLAYLIST12345678", tracks: [] } })
        .exec
    );
    await expect(
      empty.getPlaylistTracks("PLAYLIST12345678", 0, 50)
    ).resolves.toEqual({
      limit: 50,
      offset: 0,
      total: 0,
      tracks: [],
    });
  });

  test("fails with not_found for unknown and hostile playlist IDs", async () => {
    const { exec } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: library },
    });
    const operations = createTrackOperations(exec);
    const hostile = `A"); throw new Error("pwned"); (\`${String.fromCharCode(0x20_28)}`;

    await expect(
      operations.getPlaylistTracks("PLAYLIST00000000", 0, 50)
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      operations.getPlaylistTracks(hostile, 0, 50)
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("rejects schema-invalid script payloads", async () => {
    const operations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        tracks: [{ id: "X" }],
        total: 1,
        offset: 0,
        limit: 50,
      }),
    }));

    await expect(
      operations.getPlaylistTracks("PLAYLIST12345678", 0, 50)
    ).rejects.toMatchObject({
      code: "script_error",
    });
  });
});

describe("createTrackOperations.addTracksToPlaylist", () => {
  const library = libraryOf(5);
  const [track0, track1, track2, track3] = library as [
    LibraryTrack,
    LibraryTrack,
    LibraryTrack,
    LibraryTrack,
  ];

  test("adds library tracks in request order and classifies missing and failed IDs", async () => {
    const { exec, playlistTracks } = fakeMusic({
      failDuplicate: [track3.id],
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [track0] },
    });
    const operations = createTrackOperations(exec);

    await expect(
      operations.addTracksToPlaylist("PLAYLIST12345678", [
        track2.id,
        "FFFFFFFFFFFFFFF0",
        track3.id,
        track1.id,
      ])
    ).resolves.toEqual({
      added: 2,
      addedTrackIds: [track2.id, track1.id],
      failedTrackIds: [track3.id],
      missingTrackIds: ["FFFFFFFFFFFFFFF0"],
      playlistId: "PLAYLIST12345678",
      requested: 4,
    });
    expect(playlistTracks).toEqual([track0, track2, track1]);
  });

  test("matches IDs regardless of case and echoes them as requested", async () => {
    const { exec, playlistTracks } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [] },
    });
    const operations = createTrackOperations(exec);

    const result = await operations.addTracksToPlaylist("playlist12345678", [
      track1.id.toLowerCase(),
    ]);
    expect(result.addedTrackIds).toEqual([track1.id.toLowerCase()]);
    expect(playlistTracks).toEqual([track1]);
  });

  test("reports every ID missing against an empty library", async () => {
    const { exec } = fakeMusic({
      library: [],
      playlist: { id: "PLAYLIST12345678", tracks: [] },
    });
    const operations = createTrackOperations(exec);

    const result = await operations.addTracksToPlaylist("PLAYLIST12345678", [
      track0.id,
    ]);
    expect(result.missingTrackIds).toEqual([track0.id]);
    expect(result.added).toBe(0);
  });

  test("fails with not_found when the playlist does not exist", async () => {
    const { exec } = fakeMusic({ library });
    const operations = createTrackOperations(exec);

    await expect(
      operations.addTracksToPlaylist("PLAYLIST12345678", [track0.id])
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("passes hostile IDs to Music as data, not code", async () => {
    const hostile = `A"); throw new Error("pwned"); (\`${String.fromCharCode(0x20_28)}`;
    const { exec, playlistTracks } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [] },
    });
    const operations = createTrackOperations(exec);

    const result = await operations.addTracksToPlaylist("PLAYLIST12345678", [
      hostile,
      track0.id,
    ]);
    expect(result.missingTrackIds).toEqual([hostile]);
    expect(playlistTracks).toEqual([track0]);
    await expect(
      operations.addTracksToPlaylist(hostile, [track0.id])
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("createTrackOperations.removeTracksFromPlaylist", () => {
  const library = libraryOf(4);
  const [trackA, trackB, trackC] = library as [
    LibraryTrack,
    LibraryTrack,
    LibraryTrack,
  ];

  test("removes every instance of each requested track and reports missing IDs", async () => {
    const { exec, playlistTracks } = fakeMusic({
      library,
      playlist: {
        id: "PLAYLIST12345678",
        tracks: [trackA, trackB, trackA, trackC],
      },
    });
    const operations = createTrackOperations(exec);

    const result = await operations.removeTracksFromPlaylist(
      "PLAYLIST12345678",
      [trackA.id, trackC.id, "FFFFFFFFFFFFFFF0"]
    );
    expect(result).toMatchObject({
      failedTrackIds: [],
      missingTrackIds: ["FFFFFFFFFFFFFFF0"],
      playlistId: "PLAYLIST12345678",
      removed: 3,
      requested: 3,
    });
    expect([...result.removedTrackIds].sort()).toEqual(
      [trackA.id, trackC.id].sort()
    );
    expect(playlistTracks).toEqual([trackB]);
  });

  test("reports a track as both removed and failed when one instance resists deletion", async () => {
    const { exec, playlistTracks } = fakeMusic({
      failDeleteAt: [0],
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [trackA, trackB, trackA] },
    });
    const operations = createTrackOperations(exec);

    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [trackA.id])
    ).resolves.toEqual({
      failedTrackIds: [trackA.id],
      missingTrackIds: [],
      playlistId: "PLAYLIST12345678",
      removed: 1,
      removedTrackIds: [trackA.id],
      requested: 1,
    });
    expect(playlistTracks).toEqual([trackA, trackB]);
  });

  test("matches IDs regardless of case and echoes them as requested", async () => {
    const { exec, playlistTracks } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [trackA, trackB] },
    });
    const operations = createTrackOperations(exec);

    const result = await operations.removeTracksFromPlaylist(
      "playlist12345678",
      [trackB.id.toLowerCase()]
    );
    expect(result.removedTrackIds).toEqual([trackB.id.toLowerCase()]);
    expect(playlistTracks).toEqual([trackA]);
  });

  test("reports every ID missing against an empty playlist", async () => {
    const { exec } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [] },
    });
    const operations = createTrackOperations(exec);

    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        trackA.id,
        trackB.id,
      ])
    ).resolves.toMatchObject({
      failedTrackIds: [],
      missingTrackIds: [trackA.id, trackB.id],
      removed: 0,
      removedTrackIds: [],
    });
  });

  test("fails with not_found when the playlist does not exist", async () => {
    const { exec } = fakeMusic({ library });
    const operations = createTrackOperations(exec);

    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [trackA.id])
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("passes hostile IDs to Music as data, not code", async () => {
    const hostile = `A"); throw new Error("pwned"); (\`${String.fromCharCode(0x20_29)}`;
    const { exec, playlistTracks } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [trackA] },
    });
    const operations = createTrackOperations(exec);

    const result = await operations.removeTracksFromPlaylist(
      "PLAYLIST12345678",
      [hostile]
    );
    expect(result.missingTrackIds).toEqual([hostile]);
    expect(playlistTracks).toEqual([trackA]);
    await expect(
      operations.removeTracksFromPlaylist(hostile, [trackA.id])
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("createTrackOperations mutations", () => {
  test("returns add success, missing, and duplicate-failure classifications", async () => {
    const operations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 3,
        added: 1,
        addedTrackIds: ["TRACK00000000001"],
        missingTrackIds: ["TRACK00000000002"],
        failedTrackIds: ["TRACK00000000003"],
      }),
    }));

    await expect(
      operations.addTracksToPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
        "TRACK00000000003",
      ])
    ).resolves.toEqual({
      added: 1,
      addedTrackIds: ["TRACK00000000001"],
      failedTrackIds: ["TRACK00000000003"],
      missingTrackIds: ["TRACK00000000002"],
      playlistId: "PLAYLIST12345678",
      requested: 3,
    });
  });

  test("rejects inconsistent add counts", async () => {
    const operations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 2,
        added: 1,
        addedTrackIds: ["TRACK00000000001"],
        missingTrackIds: [],
        failedTrackIds: [],
      }),
    }));

    await expect(
      operations.addTracksToPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
      ])
    ).rejects.toMatchObject({ code: "script_error" });
  });

  test("returns removal instances, missing IDs, and failed deletes", async () => {
    const operations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 4,
        removed: 3,
        removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
        missingTrackIds: ["TRACK00000000004"],
        failedTrackIds: ["TRACK00000000002", "TRACK00000000003"],
      }),
    }));

    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
        "TRACK00000000003",
        "TRACK00000000004",
      ])
    ).resolves.toEqual({
      failedTrackIds: ["TRACK00000000002", "TRACK00000000003"],
      missingTrackIds: ["TRACK00000000004"],
      playlistId: "PLAYLIST12345678",
      removed: 3,
      removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
      requested: 4,
    });
  });

  test("rejects classifications that do not match the request", async () => {
    const addOperations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 2,
        added: 1,
        addedTrackIds: ["TRACK00000000001"],
        missingTrackIds: ["TRACK00000000009"],
        failedTrackIds: [],
      }),
    }));
    await expect(
      addOperations.addTracksToPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
      ])
    ).rejects.toMatchObject({ code: "script_error" });

    const removeOperations = createTrackOperations(async () => ({
      stderr: "",
      stdout: JSON.stringify({
        playlistId: "PLAYLIST12345678",
        requested: 2,
        removed: 1,
        removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
        missingTrackIds: [],
        failedTrackIds: [],
      }),
    }));
    await expect(
      removeOperations.removeTracksFromPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
      ])
    ).rejects.toMatchObject({ code: "script_error" });
  });
  test("rejects duplicate IDs before invoking AppleScript", async () => {
    let invocations = 0;
    const operations = createTrackOperations(async () => {
      invocations += 1;
      return { stderr: "", stdout: "{}" };
    });

    await expect(
      operations.addTracksToPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000001",
      ])
    ).rejects.toThrow("Track IDs must be unique.");
    await expect(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000001",
      ])
    ).rejects.toThrow("Track IDs must be unique.");
    expect(invocations).toBe(0);
  });
});
