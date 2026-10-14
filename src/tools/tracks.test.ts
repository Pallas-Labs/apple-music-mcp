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

const trackColumns = (tracks: LibraryTrack[]) => ({
  album: tracks.map((track) => track.album),
  artist: tracks.map((track) => track.artist),
  duration: tracks.map((track) => track.duration),
  genre: tracks.map((track) => track.genre),
  name: tracks.map((track) => track.name),
  persistentID: tracks.map((track) => track.id),
  playCount: tracks.map((track) => track.playCount),
  year: tracks.map((track) => track.year),
});

const execReturning =
  (stdout: string): ExecFn =>
  async () =>
    await Promise.resolve({ stderr: "", stdout });

const rejectionOf = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (error) {
    if (Error.isError(error)) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the promise to reject with an Error.");
};

type WhoseClause = Record<string, Record<string, string | number>>;

interface ScriptCall {
  language: ScriptLanguage;
  whoseArgument: WhoseClause | string;
}

/**
 * An exec that runs the generated JXA against a fake Music library. The library answers every
 * whose clause with the given columns, and throws on property reads of an empty result as Music
 * does.
 */
const fakeMusicExec = (columns: Record<string, unknown[]>) => {
  const calls: ScriptCall[] = [];
  const count = columns.persistentID?.length ?? 0;
  const collection = {
    ...Object.fromEntries(
      Object.entries(columns).map(([name, values]) => [
        name === "playCount" ? "playedCount" : name,
        () => {
          if (count === 0) {
            throw new Error("Can't get object.");
          }
          return values;
        },
      ])
    ),
    length: count,
  };
  const exec: ExecFn = async (script, _timeoutMs, language) => {
    const call: ScriptCall = { language, whoseArgument: "whose not called" };
    calls.push(call);
    const tracks = {
      ...collection,
      whose: (argument: WhoseClause) => {
        call.whoseArgument = argument;
        return collection;
      },
    };
    const Application = () => ({
      launch: () => {},
      libraryPlaylists: [{ tracks }],
      running: () => true,
    });
    const stdout = String(
      vm.runInNewContext(script, {
        Application,
        delay: () => {},
      })
    );
    return await Promise.resolve({ stderr: "", stdout });
  };
  return { calls, exec };
};

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
const fakeMusic = (options: FakeMusicOptions) => {
  const playlistTracks = [...(options.playlist?.tracks ?? [])];
  // Each playlist entry carries its own database ID in Music, distinct from the library track's.
  const entryIds = playlistTracks.map((_, index) => 1000 + index);
  let nextEntryId = 1000 + playlistTracks.length;
  const failDuplicate = new Set(options.failDuplicate);
  const failDeleteAt = new Set(options.failDeleteAt);
  const libraryDatabaseId = (track: LibraryTrack) =>
    options.library.indexOf(track) + 1;

  type Kind = "library" | "playlist";
  interface Spec {
    kind: Kind;
    index: number;
  }
  interface FakeCollection {
    byId: (databaseId: number) => Spec;
    slice: (start: number, end: number) => FakeCollection;
  }
  const columns = {
    album: (track: LibraryTrack) => track.album,
    artist: (track: LibraryTrack) => track.artist,
    duration: (track: LibraryTrack) => track.duration,
    genre: (track: LibraryTrack) => track.genre,
    id: (track: LibraryTrack, index: number, kind: Kind) =>
      kind === "library" ? libraryDatabaseId(track) : entryIds[index],
    name: (track: LibraryTrack) => track.name,
    persistentID: (track: LibraryTrack) => track.id,
    playedCount: (track: LibraryTrack) => track.playCount,
    year: (track: LibraryTrack) => track.year,
  };

  /** One element specifier: a handle for duplicate/delete that also reads its own properties. */
  const element = (
    kind: Kind,
    tracks: () => LibraryTrack[],
    index: number
  ): Spec => ({
    ...Object.fromEntries(
      Object.entries(columns).map(([name, read]) => [
        name,
        () => {
          const track = tracks()[index];
          if (!track) {
            throw new Error(MUSIC_NOT_FOUND);
          }
          return read(track, index, kind);
        },
      ])
    ),
    index,
    kind,
  });

  const collection = (
    kind: Kind,
    tracks: () => LibraryTrack[]
  ): FakeCollection => {
    const readers = new Map(
      Object.entries(columns).map(([name, read]) => [
        name,
        () => {
          if (tracks().length === 0) {
            throw new Error(MUSIC_NOT_FOUND);
          }
          return tracks().map((track, index) => read(track, index, kind));
        },
      ])
    );
    const target = {
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
    return new Proxy(target, {
      get(object, property) {
        if (property === "length") {
          return tracks().length;
        }
        const name = String(property);
        if (/^\d+$/u.test(name)) {
          return element(kind, tracks, Number(name));
        }
        if (name === "byId" || name === "slice") {
          return object[name];
        }
        return readers.get(name);
      },
    });
  };

  const libraryTracks = collection("library", () => options.library);
  const playlistCollection = collection("playlist", () => playlistTracks);
  const playlistObject = { id: () => 7, tracks: playlistCollection };
  const music = {
    delete: (spec: Spec) => {
      if (spec.kind !== "playlist" || spec.index >= playlistTracks.length) {
        throw new Error(MUSIC_NOT_FOUND);
      }
      if (failDeleteAt.has(spec.index)) {
        throw new Error("Music got an error: Can't delete.");
      }
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
    launch: () => {},
    libraryPlaylists: [{ tracks: libraryTracks }],
    running: () => true,
    userPlaylists: {
      byId: (databaseId: number) => {
        if (databaseId !== 7) {
          throw new Error(MUSIC_NOT_FOUND);
        }
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
      const stdout = String(
        vm.runInNewContext(script, {
          Application: () => music,
          delay: () => {},
        })
      );
      return await Promise.resolve({ stderr: "", stdout });
    } catch (error) {
      // osascript reports script errors on stderr with the Apple error number in parentheses.
      throw Object.assign(new Error("osascript failed"), {
        stderr: `execution error: Error: ${Error.isError(error) ? error.message : String(error)}`,
      });
    }
  };
  return { exec, playlistTracks };
};

const libraryTrack = (index: number): LibraryTrack => ({
  ...sampleTrack,
  id: `TRACK${index.toString().padStart(11, "0")}`,
  name: `Track ${index}`,
});

const libraryOf = (count: number): LibraryTrack[] =>
  Array.from({ length: count }, (_, index) => libraryTrack(index));

const toPlaylistTrack = (track: LibraryTrack) => ({
  album: track.album,
  artist: track.artist,
  duration: track.duration,
  id: track.id,
  name: track.name,
});

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

    const missingFilter = await rejectionOf(operations.findTracks({}));
    expect(missingFilter.message).toContain(
      "At least one track filter is required."
    );
    const reversedYears = await rejectionOf(
      operations.findTracks({ yearMax: 2020, yearMin: 2025 })
    );
    expect(reversedYears.message).toContain(
      "yearMin must be less than or equal to yearMax."
    );
    const reversedPlayCounts = await rejectionOf(
      operations.findTracks({ playCountMax: 2, playCountMin: 10 })
    );
    expect(reversedPlayCounts.message).toContain(
      "playCountMin must be less than or equal to playCountMax."
    );
    expect(calls).toHaveLength(0);
  });

  test("asks Music for the text filter and reads matching rows column by column", async () => {
    const loveLost = {
      ...sampleTrack,
      id: "TRACK00000000001",
      name: "Love Lost",
      playCount: 1,
      year: 2001,
    };
    const glove = {
      ...sampleTrack,
      id: "TRACK00000000002",
      name: "Glove",
      playCount: 9,
      year: 2002,
    };
    const { exec, calls } = fakeMusicExec(trackColumns([loveLost, glove]));
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
      tracks: [glove, loveLost],
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
    expect(calls[0]?.whoseArgument).toEqual({
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
    const hostile = `a"b\\c\nd${String.fromCodePoint(0x20_28)}e\`); throw new Error("pwned"); (\``;

    await operations.findTracks({ artist: hostile });
    expect(calls[0]?.whoseArgument).toEqual({ artist: { _contains: hostile } });
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
    expect(result.tracks[0]?.playCount).toBe(FIND_TRACKS_CANDIDATE_CAP - 1);
  });

  test("fails when Music returns columns of different lengths", async () => {
    const columns = trackColumns([
      sampleTrack,
      { ...sampleTrack, id: "TRACK00000000002" },
    ]);
    columns.year = [2024];
    const { exec } = fakeMusicExec(columns);
    const operations = createTrackOperations(exec);

    expect(
      await rejectionOf(operations.findTracks({ yearMin: 2000 }))
    ).toMatchObject({
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
    const payloads = [
      JSON.stringify({ scanned: 1, tracks: "not-an-array", truncated: false }),
      JSON.stringify({
        columns: { ...validColumns, years: ["2001"] },
        scanned: 1,
        truncated: false,
      }),
      JSON.stringify({
        columns: { ...validColumns, names: [] },
        scanned: 1,
        truncated: false,
      }),
      JSON.stringify({ columns: validColumns, scanned: 2, truncated: false }),
      JSON.stringify({ columns: validColumns, scanned: 1, truncated: "no" }),
      "not json",
    ];
    await Promise.all(
      payloads.map(async (payload) => {
        const operations = createTrackOperations(execReturning(payload));
        expect(
          await rejectionOf(operations.findTracks({ yearMin: 2000 }))
        ).toMatchObject({
          code: "script_error",
        });
      })
    );

    const operations = createTrackOperations(
      execReturning(
        JSON.stringify({
          columns: validColumns,
          scanned: 1,
          truncated: false,
        })
      )
    );
    expect(await operations.findTracks({ yearMin: 2000 })).toMatchObject({
      totalMatched: 1,
      tracks: [
        { id: "TRACK00000000001", name: "Love", playCount: 3, year: 2001 },
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

  test("returns the requested page with the playlist total", async () => {
    const { exec } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: library },
    });
    const operations = createTrackOperations(exec);

    expect(
      await operations.getPlaylistTracks("playlist12345678", 1, 2)
    ).toEqual({
      limit: 2,
      offset: 1,
      total: 5,
      tracks: library.slice(1, 3).map(toPlaylistTrack),
    });
  });

  test("returns a final page holding a single track", async () => {
    const { exec } = fakeMusic({
      library,
      playlist: { id: "PLAYLIST12345678", tracks: library },
    });
    const operations = createTrackOperations(exec);

    expect(
      await operations.getPlaylistTracks("PLAYLIST12345678", 4, 10)
    ).toEqual({
      limit: 10,
      offset: 4,
      total: 5,
      tracks: library.slice(4).map(toPlaylistTrack),
    });
  });

  test("returns an empty page past the end and for an empty playlist", async () => {
    const full = createTrackOperations(
      fakeMusic({
        library,
        playlist: { id: "PLAYLIST12345678", tracks: library },
      }).exec
    );
    expect(await full.getPlaylistTracks("PLAYLIST12345678", 5, 50)).toEqual({
      limit: 50,
      offset: 5,
      total: 5,
      tracks: [],
    });

    const empty = createTrackOperations(
      fakeMusic({ library, playlist: { id: "PLAYLIST12345678", tracks: [] } })
        .exec
    );
    expect(await empty.getPlaylistTracks("PLAYLIST12345678", 0, 50)).toEqual({
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
    const hostile = `A"); throw new Error("pwned"); (\`${String.fromCodePoint(0x20_28)}`;

    expect(
      await rejectionOf(operations.getPlaylistTracks("PLAYLIST00000000", 0, 50))
    ).toMatchObject({
      code: "not_found",
    });
    expect(
      await rejectionOf(operations.getPlaylistTracks(hostile, 0, 50))
    ).toMatchObject({
      code: "not_found",
    });
  });

  test("rejects schema-invalid script payloads", async () => {
    const operations = createTrackOperations(
      execReturning(
        JSON.stringify({
          limit: 50,
          offset: 0,
          total: 1,
          tracks: [{ id: "X" }],
        })
      )
    );

    expect(
      await rejectionOf(operations.getPlaylistTracks("PLAYLIST12345678", 0, 50))
    ).toMatchObject({
      code: "script_error",
    });
  });
});

describe("createTrackOperations.addTracksToPlaylist", () => {
  const track0 = libraryTrack(0);
  const track1 = libraryTrack(1);
  const track2 = libraryTrack(2);
  const track3 = libraryTrack(3);
  const library = [track0, track1, track2, track3, libraryTrack(4)];

  test("adds library tracks in request order and classifies missing and failed IDs", async () => {
    const { exec, playlistTracks } = fakeMusic({
      failDuplicate: [track3.id],
      library,
      playlist: { id: "PLAYLIST12345678", tracks: [track0] },
    });
    const operations = createTrackOperations(exec);

    expect(
      await operations.addTracksToPlaylist("PLAYLIST12345678", [
        track2.id,
        "FFFFFFFFFFFFFFF0",
        track3.id,
        track1.id,
      ])
    ).toEqual({
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

    expect(
      await rejectionOf(
        operations.addTracksToPlaylist("PLAYLIST12345678", [track0.id])
      )
    ).toMatchObject({ code: "not_found" });
  });

  test("passes hostile IDs to Music as data, not code", async () => {
    const hostile = `A"); throw new Error("pwned"); (\`${String.fromCodePoint(0x20_28)}`;
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
    expect(
      await rejectionOf(operations.addTracksToPlaylist(hostile, [track0.id]))
    ).toMatchObject({
      code: "not_found",
    });
  });
});

describe("createTrackOperations.removeTracksFromPlaylist", () => {
  const trackA = libraryTrack(0);
  const trackB = libraryTrack(1);
  const trackC = libraryTrack(2);
  const library = [trackA, trackB, trackC, libraryTrack(3)];

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
    expect(result.removedTrackIds).toHaveLength(2);
    expect(new Set(result.removedTrackIds)).toEqual(
      new Set([trackA.id, trackC.id])
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

    expect(
      await operations.removeTracksFromPlaylist("PLAYLIST12345678", [trackA.id])
    ).toEqual({
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

    expect(
      await operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        trackA.id,
        trackB.id,
      ])
    ).toMatchObject({
      failedTrackIds: [],
      missingTrackIds: [trackA.id, trackB.id],
      removed: 0,
      removedTrackIds: [],
    });
  });

  test("fails with not_found when the playlist does not exist", async () => {
    const { exec } = fakeMusic({ library });
    const operations = createTrackOperations(exec);

    expect(
      await rejectionOf(
        operations.removeTracksFromPlaylist("PLAYLIST12345678", [trackA.id])
      )
    ).toMatchObject({ code: "not_found" });
  });

  test("passes hostile IDs to Music as data, not code", async () => {
    const hostile = `A"); throw new Error("pwned"); (\`${String.fromCodePoint(0x20_29)}`;
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
    expect(
      await rejectionOf(
        operations.removeTracksFromPlaylist(hostile, [trackA.id])
      )
    ).toMatchObject({
      code: "not_found",
    });
  });
});

describe("createTrackOperations mutations", () => {
  test("returns add success, missing, and duplicate-failure classifications", async () => {
    const operations = createTrackOperations(
      execReturning(
        JSON.stringify({
          added: 1,
          addedTrackIds: ["TRACK00000000001"],
          failedTrackIds: ["TRACK00000000003"],
          missingTrackIds: ["TRACK00000000002"],
          playlistId: "PLAYLIST12345678",
          requested: 3,
        })
      )
    );

    expect(
      await operations.addTracksToPlaylist("playlist12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
        "TRACK00000000003",
      ])
    ).toEqual({
      added: 1,
      addedTrackIds: ["TRACK00000000001"],
      failedTrackIds: ["TRACK00000000003"],
      missingTrackIds: ["TRACK00000000002"],
      playlistId: "PLAYLIST12345678",
      requested: 3,
    });
  });

  test("rejects inconsistent add counts", async () => {
    const operations = createTrackOperations(
      execReturning(
        JSON.stringify({
          added: 1,
          addedTrackIds: ["TRACK00000000001"],
          failedTrackIds: [],
          missingTrackIds: [],
          playlistId: "PLAYLIST12345678",
          requested: 2,
        })
      )
    );

    expect(
      await rejectionOf(
        operations.addTracksToPlaylist("PLAYLIST12345678", [
          "TRACK00000000001",
          "TRACK00000000002",
        ])
      )
    ).toMatchObject({ code: "script_error" });
  });

  test("returns removal instances, missing IDs, and failed deletes", async () => {
    const operations = createTrackOperations(
      execReturning(
        JSON.stringify({
          failedTrackIds: ["TRACK00000000002", "TRACK00000000003"],
          missingTrackIds: ["TRACK00000000004"],
          playlistId: "PLAYLIST12345678",
          removed: 3,
          removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
          requested: 4,
        })
      )
    );

    expect(
      await operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000002",
        "TRACK00000000003",
        "TRACK00000000004",
      ])
    ).toEqual({
      failedTrackIds: ["TRACK00000000002", "TRACK00000000003"],
      missingTrackIds: ["TRACK00000000004"],
      playlistId: "PLAYLIST12345678",
      removed: 3,
      removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
      requested: 4,
    });
  });

  test("rejects classifications that do not match the request", async () => {
    const addOperations = createTrackOperations(
      execReturning(
        JSON.stringify({
          added: 1,
          addedTrackIds: ["TRACK00000000001"],
          failedTrackIds: [],
          missingTrackIds: ["TRACK00000000009"],
          playlistId: "PLAYLIST12345678",
          requested: 2,
        })
      )
    );
    expect(
      await rejectionOf(
        addOperations.addTracksToPlaylist("playlist12345678", [
          "TRACK00000000001",
          "TRACK00000000002",
        ])
      )
    ).toMatchObject({ code: "script_error" });

    const removeOperations = createTrackOperations(
      execReturning(
        JSON.stringify({
          failedTrackIds: [],
          missingTrackIds: [],
          playlistId: "PLAYLIST12345678",
          removed: 1,
          removedTrackIds: ["TRACK00000000001", "TRACK00000000002"],
          requested: 2,
        })
      )
    );
    expect(
      await rejectionOf(
        removeOperations.removeTracksFromPlaylist("playlist12345678", [
          "TRACK00000000001",
          "TRACK00000000002",
        ])
      )
    ).toMatchObject({ code: "script_error" });
  });
  test("rejects duplicate IDs before invoking AppleScript", async () => {
    let invocations = 0;
    const operations = createTrackOperations(async () => {
      invocations += 1;
      return await Promise.resolve({ stderr: "", stdout: "{}" });
    });

    const duplicateAdd = await rejectionOf(
      operations.addTracksToPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000001",
      ])
    );
    expect(duplicateAdd.message).toContain("Track IDs must be unique.");
    const duplicateRemove = await rejectionOf(
      operations.removeTracksFromPlaylist("PLAYLIST12345678", [
        "TRACK00000000001",
        "TRACK00000000001",
      ])
    );
    expect(duplicateRemove.message).toContain("Track IDs must be unique.");
    expect(invocations).toBe(0);
  });
});
