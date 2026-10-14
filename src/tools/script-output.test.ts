import { describe, expect, test } from "bun:test";

import type { ExecFn } from "../applescript/runner.js";
import { MusicToolError } from "../types.js";
import { createFolderOperations } from "./folders.js";
import { createMoveOperations } from "./move.js";
import { createPlaybackOperations } from "./playback.js";
import { createPlaylistOperations } from "./playlists.js";
import { createSearchOperations } from "./search.js";

/** Answers each script with the next payload in order. */
function scriptedRunner(...payloads: string[]): ExecFn {
  let call = 0;
  return async () => ({ stderr: "", stdout: payloads[call++] ?? "" });
}

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
  run: (execFn: ExecFn) => Promise<unknown>;
  /** Payloads that come before the one under test, such as an earlier script in the same call. */
  before?: string[];
  /** Payloads that come after the one under test, such as a later script in the same call. */
  after?: string[];
  valid: string;
  expected: unknown;
  wrongShape: string;
  message: string;
}

const CASES: Case[] = [
  {
    after: [JSON.stringify(["", "AAAA1111BBBB2222"])],
    expected: [
      { id: "AAAA1111BBBB2222", name: "Top", isRoot: true },
      {
        id: "CCCC3333DDDD4444",
        name: "Nested",
        isRoot: false,
        parentId: "AAAA1111BBBB2222",
      },
    ],
    message: "Music returned an invalid playlist payload.",
    name: "music.list_folders",
    run:  async (execFn) => createFolderOperations(execFn).listFolders(true),
    valid: PLAYLIST_ENTRIES,
    wrongShape: JSON.stringify([
      { id: "AAAA1111BBBB2222", name: "Top", kind: "smart" },
    ]),
  },
  {
    before: [PLAYLIST_ENTRIES],
    expected: [
      {
        id: "CCCC3333DDDD4444",
        name: "Nested",
        isRoot: false,
        parentId: "AAAA1111BBBB2222",
      },
    ],
    message: "Music returned an invalid playlist parent payload.",
    name: "music.list_folders non-empty filter",
    run:  async (execFn) => createFolderOperations(execFn).listFolders(false),
    valid: JSON.stringify(["", "AAAA1111BBBB2222", "CCCC3333DDDD4444"]),
    wrongShape: JSON.stringify(["", "AAAA1111BBBB2222"]),
  },
  {
    expected: { id: "AAAA1111BBBB2222", isRoot: true, name: "Top" },
    message: "Music returned an invalid create folder payload.",
    name: "music.create_folder",
    run:  async (execFn) =>
      createFolderOperations(execFn).createFolder({ name: "Top" }),
    valid: JSON.stringify({
      id: "AAAA1111BBBB2222",
      name: "Top",
      parentId: "",
    }),
    wrongShape: JSON.stringify({
      id: "AAAA1111BBBB2222",
      name: 7,
      parentId: "",
    }),
  },
  {
    expected: [
      {
        id: "AAAABBBBCCCCDDDD",
        name: "Song",
        artist: "Artist",
        album: "Album",
        duration: 201.5,
      },
    ],
    message: "Music returned an invalid search payload.",
    name: "music.search_library",
    run:  async (execFn) => createSearchOperations(execFn).searchLibrary("love", 5),
    valid: JSON.stringify([
      {
        id: "AAAABBBBCCCCDDDD",
        name: "Song",
        artist: "Artist",
        album: "Album",
        duration: 201.5,
      },
    ]),
    wrongShape: JSON.stringify([
      { id: "AAAABBBBCCCCDDDD", name: "Song", duration: "3:21" },
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
    message: "Music returned an invalid move playlist payload.",
    name: "music.move_playlist",
    run:  async (execFn) =>
      createMoveOperations(execFn).movePlaylist({
        playlistId: "ABCDEF1234567890",
        targetFolderId: "AAAA1111BBBB2222",
      }),
    valid: JSON.stringify({ ...PLAYLIST_ROW, folderId: "AAAA1111BBBB2222" }),
    wrongShape: JSON.stringify({ ...PLAYLIST_ROW, isSmart: "false" }),
  },
  {
    after: [JSON.stringify(["AAAA1111BBBB2222"])],
    expected: [
      {
        id: "ABCDEF1234567890",
        name: "Road Trip",
        isSmart: false,
        folderId: "AAAA1111BBBB2222",
      },
    ],
    message: "Music returned an invalid playlist payload.",
    name: "music.list_playlists",
    run:  async (execFn) => createPlaylistOperations(execFn).listPlaylists({}),
    valid: PLAYLIST_ENTRIES,
    wrongShape: JSON.stringify([
      { id: "ABCDEF1234567890", name: "Road Trip", kind: "user" },
    ]),
  },
  {
    expected: {
      id: "ABCDEF1234567890",
      isSmart: false,
      name: "Road Trip",
      trackCount: 0,
    },
    message: "Music returned an invalid create playlist payload.",
    name: "music.create_playlist",
    run:  async (execFn) =>
      createPlaylistOperations(execFn).createPlaylist({ name: "Road Trip" }),
    valid: JSON.stringify({ ...PLAYLIST_ROW, trackCount: 0 }),
    wrongShape: JSON.stringify({ id: "ABCDEF1234567890", name: "Road Trip" }),
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
    message: "Music returned an invalid now playing payload.",
    name: "music.get_now_playing",
    run:  async (execFn) => createPlaybackOperations(execFn).getNowPlaying(),
    valid: JSON.stringify({
      playerState: "paused",
      name: "Song",
      artist: "Artist",
      album: "Album",
      duration: 222.2,
      position: 5.7,
    }),
    wrongShape: JSON.stringify({
      playerState: "fast forwarding",
      name: "Song",
      artist: "Artist",
      album: "Album",
      duration: 222.2,
      position: 5.7,
    }),
  },
  {
    expected: { action: "pause", playerState: "paused", success: true },
    message: "Music returned an invalid playback control payload.",
    name: "music.playback_control",
    run:  async (execFn) => createPlaybackOperations(execFn).controlPlayback("pause"),
    valid: JSON.stringify({
      success: true,
      action: "pause",
      playerState: "paused",
    }),
    wrongShape: JSON.stringify({ success: true, action: "pause" }),
  },
];

async function errorOf(promise: Promise<unknown>): Promise<MusicToolError> {
  const error = await promise.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(MusicToolError);
  return error as MusicToolError;
}

describe("script output validation", () => {
  for (const {
    name,
    run,
    before = [],
    after = [],
    valid,
    expected,
    wrongShape,
    message,
  } of CASES) {
    test(`${name} accepts a well-formed payload`, async () => {
      expect(await run(scriptedRunner(...before, valid, ...after))).toEqual(
        expected
      );
    });

    test(`${name} rejects malformed payloads with script_error`, async () => {
      for (const payload of ["not json", "", wrongShape]) {
        const error = await errorOf(
          run(scriptedRunner(...before, payload, ...after))
        );
        expect(error.code).toBe("script_error");
        expect(error.message).toBe(message);
      }
    });
  }
});
