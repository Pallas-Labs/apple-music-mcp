import { describe, expect, test } from "bun:test";

import type { ExecFn } from "../applescript/runner.js";
import { MusicToolError } from "../types.js";
import { createFolderOperations } from "./folders.js";
import { createMoveOperations } from "./move.js";
import { createPlaybackOperations } from "./playback.js";
import { createPlaylistOperations } from "./playlists.js";
import { createSearchOperations } from "./search.js";

/** Answers each script with the next payload in order. */
const scriptedRunner = (...payloads: string[]): ExecFn => {
  let call = 0;
  return async () => {
    const stdout = payloads[call] ?? "";
    call += 1;
    return await Promise.resolve({ stderr: "", stdout });
  };
};

const PLAYLIST_ENTRIES = JSON.stringify([
  { id: "AAAA1111BBBB2222", isSmart: false, kind: "folder", name: "Top" },
  { id: "CCCC3333DDDD4444", isSmart: false, kind: "folder", name: "Nested" },
  { id: "ABCDEF1234567890", isSmart: false, kind: "user", name: "Road Trip" },
]);
const PLAYLIST_ROW = {
  folderId: "",
  id: "ABCDEF1234567890",
  isSmart: false,
  name: "Road Trip",
  trackCount: 12,
};

interface Case {
  name: string;
  run: (execFn: ExecFn) => Promise<object>;
  /** Payloads that come before the one under test, such as an earlier script in the same call. */
  before?: string[];
  /** Payloads that come after the one under test, such as a later script in the same call. */
  after?: string[];
  valid: string;
  expected: object;
  /** Well-formed JSON that does not match the expected schema. */
  invalid: string;
  message: string;
}

const CASES: Case[] = [
  {
    after: [JSON.stringify(["", "AAAA1111BBBB2222"])],
    expected: [
      { id: "AAAA1111BBBB2222", isRoot: true, name: "Top" },
      {
        id: "CCCC3333DDDD4444",
        isRoot: false,
        name: "Nested",
        parentId: "AAAA1111BBBB2222",
      },
    ],
    invalid: JSON.stringify([
      { id: "AAAA1111BBBB2222", kind: "smart", name: "Top" },
    ]),
    message: "Music returned an invalid playlist payload.",
    name: "music.list_folders",
    run: async (execFn) =>
      await createFolderOperations(execFn).listFolders(true),
    valid: PLAYLIST_ENTRIES,
  },
  {
    before: [PLAYLIST_ENTRIES],
    expected: [
      {
        id: "CCCC3333DDDD4444",
        isRoot: false,
        name: "Nested",
        parentId: "AAAA1111BBBB2222",
      },
    ],
    invalid: JSON.stringify(["", "AAAA1111BBBB2222"]),
    message: "Music returned an invalid playlist parent payload.",
    name: "music.list_folders non-empty filter",
    run: async (execFn) =>
      await createFolderOperations(execFn).listFolders(false),
    valid: JSON.stringify(["", "AAAA1111BBBB2222", "CCCC3333DDDD4444"]),
  },
  {
    expected: { id: "AAAA1111BBBB2222", isRoot: true, name: "Top" },
    invalid: JSON.stringify({
      id: "AAAA1111BBBB2222",
      name: 7,
      parentId: "",
    }),
    message: "Music returned an invalid create folder payload.",
    name: "music.create_folder",
    run: async (execFn) =>
      await createFolderOperations(execFn).createFolder({ name: "Top" }),
    valid: JSON.stringify({
      id: "AAAA1111BBBB2222",
      name: "Top",
      parentId: "",
    }),
  },
  {
    expected: [
      {
        album: "Album",
        artist: "Artist",
        duration: 201.5,
        id: "AAAABBBBCCCCDDDD",
        name: "Song",
      },
    ],
    invalid: JSON.stringify([
      { duration: "3:21", id: "AAAABBBBCCCCDDDD", name: "Song" },
    ]),
    message: "Music returned an invalid search payload.",
    name: "music.search_library",
    run: async (execFn) =>
      await createSearchOperations(execFn).searchLibrary("love", 5),
    valid: JSON.stringify([
      {
        album: "Album",
        artist: "Artist",
        duration: 201.5,
        id: "AAAABBBBCCCCDDDD",
        name: "Song",
      },
    ]),
  },
  {
    expected: {
      folderId: "AAAA1111BBBB2222",
      id: "ABCDEF1234567890",
      isSmart: false,
      name: "Road Trip",
      trackCount: 12,
    },
    invalid: JSON.stringify({ ...PLAYLIST_ROW, isSmart: "false" }),
    message: "Music returned an invalid move playlist payload.",
    name: "music.move_playlist",
    run: async (execFn) =>
      await createMoveOperations(execFn).movePlaylist({
        playlistId: "ABCDEF1234567890",
        targetFolderId: "AAAA1111BBBB2222",
      }),
    valid: JSON.stringify({ ...PLAYLIST_ROW, folderId: "AAAA1111BBBB2222" }),
  },
  {
    after: [JSON.stringify(["AAAA1111BBBB2222"])],
    expected: [
      {
        folderId: "AAAA1111BBBB2222",
        id: "ABCDEF1234567890",
        isSmart: false,
        name: "Road Trip",
      },
    ],
    invalid: JSON.stringify([
      { id: "ABCDEF1234567890", kind: "user", name: "Road Trip" },
    ]),
    message: "Music returned an invalid playlist payload.",
    name: "music.list_playlists",
    run: async (execFn) =>
      await createPlaylistOperations(execFn).listPlaylists({}),
    valid: PLAYLIST_ENTRIES,
  },
  {
    expected: {
      id: "ABCDEF1234567890",
      isSmart: false,
      name: "Road Trip",
      trackCount: 0,
    },
    invalid: JSON.stringify({ id: "ABCDEF1234567890", name: "Road Trip" }),
    message: "Music returned an invalid create playlist payload.",
    name: "music.create_playlist",
    run: async (execFn) =>
      await createPlaylistOperations(execFn).createPlaylist({
        name: "Road Trip",
      }),
    valid: JSON.stringify({ ...PLAYLIST_ROW, trackCount: 0 }),
  },
  {
    expected: {
      album: "Album",
      artist: "Artist",
      duration: 222.2,
      name: "Song",
      playerState: "paused",
      position: 5.7,
    },
    invalid: JSON.stringify({
      album: "Album",
      artist: "Artist",
      duration: 222.2,
      name: "Song",
      playerState: "fast forwarding",
      position: 5.7,
    }),
    message: "Music returned an invalid now playing payload.",
    name: "music.get_now_playing",
    run: async (execFn) =>
      await createPlaybackOperations(execFn).getNowPlaying(),
    valid: JSON.stringify({
      album: "Album",
      artist: "Artist",
      duration: 222.2,
      name: "Song",
      playerState: "paused",
      position: 5.7,
    }),
  },
  {
    expected: { action: "pause", playerState: "paused", success: true },
    invalid: JSON.stringify({ action: "pause", success: true }),
    message: "Music returned an invalid playback control payload.",
    name: "music.playback_control",
    run: async (execFn) =>
      await createPlaybackOperations(execFn).controlPlayback("pause"),
    valid: JSON.stringify({
      action: "pause",
      playerState: "paused",
      success: true,
    }),
  },
];

const errorOf = async (promise: Promise<unknown>): Promise<MusicToolError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MusicToolError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the call to reject with a MusicToolError.");
};

describe("script output validation", () => {
  for (const {
    name,
    run,
    before = [],
    after = [],
    valid,
    expected,
    invalid,
    message,
  } of CASES) {
    test(`${name} accepts a well-formed payload`, async () => {
      expect(await run(scriptedRunner(...before, valid, ...after))).toEqual(
        expected
      );
    });

    test(`${name} rejects malformed payloads with script_error`, async () => {
      await Promise.all(
        ["not json", "", invalid].map(async (payload) => {
          const error = await errorOf(
            run(scriptedRunner(...before, payload, ...after))
          );
          expect(error.code).toBe("script_error");
          expect(error.message).toBe(message);
        })
      );
    });
  }
});
