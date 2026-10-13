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
  return async () => ({ stdout: payloads[call++] ?? "", stderr: "" });
}

const PLAYLIST_ENTRIES = JSON.stringify([
  { id: "AAAA1111BBBB2222", name: "Top", kind: "folder", isSmart: false },
  { id: "CCCC3333DDDD4444", name: "Nested", kind: "folder", isSmart: false },
  { id: "ABCDEF1234567890", name: "Road Trip", kind: "user", isSmart: false },
]);
const PLAYLIST_ROW = {
  id: "ABCDEF1234567890",
  name: "Road Trip",
  folderId: "",
  isSmart: false,
  trackCount: 12,
};

type Case = {
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
};

const CASES: Case[] = [
  {
    name: "music.list_folders",
    run: (execFn) => createFolderOperations(execFn).listFolders(true),
    valid: PLAYLIST_ENTRIES,
    after: [JSON.stringify(["", "AAAA1111BBBB2222"])],
    expected: [
      { id: "AAAA1111BBBB2222", name: "Top", isRoot: true },
      { id: "CCCC3333DDDD4444", name: "Nested", isRoot: false, parentId: "AAAA1111BBBB2222" },
    ],
    wrongShape: JSON.stringify([{ id: "AAAA1111BBBB2222", name: "Top", kind: "smart" }]),
    message: "Music returned an invalid playlist payload.",
  },
  {
    name: "music.list_folders non-empty filter",
    run: (execFn) => createFolderOperations(execFn).listFolders(false),
    before: [PLAYLIST_ENTRIES],
    valid: JSON.stringify(["", "AAAA1111BBBB2222", "CCCC3333DDDD4444"]),
    expected: [
      { id: "CCCC3333DDDD4444", name: "Nested", isRoot: false, parentId: "AAAA1111BBBB2222" },
    ],
    wrongShape: JSON.stringify(["", "AAAA1111BBBB2222"]),
    message: "Music returned an invalid playlist parent payload.",
  },
  {
    name: "music.create_folder",
    run: (execFn) => createFolderOperations(execFn).createFolder({ name: "Top" }),
    valid: JSON.stringify({ id: "AAAA1111BBBB2222", name: "Top", parentId: "" }),
    expected: { id: "AAAA1111BBBB2222", name: "Top", isRoot: true },
    wrongShape: JSON.stringify({ id: "AAAA1111BBBB2222", name: 7, parentId: "" }),
    message: "Music returned an invalid create folder payload.",
  },
  {
    name: "music.search_library",
    run: (execFn) => createSearchOperations(execFn).searchLibrary("love", 5),
    valid: JSON.stringify([
      { id: "AAAABBBBCCCCDDDD", name: "Song", artist: "Artist", album: "Album", duration: 201.5 },
    ]),
    expected: [
      { id: "AAAABBBBCCCCDDDD", name: "Song", artist: "Artist", album: "Album", duration: 201.5 },
    ],
    wrongShape: JSON.stringify([{ id: "AAAABBBBCCCCDDDD", name: "Song", duration: "3:21" }]),
    message: "Music returned an invalid search payload.",
  },
  {
    name: "music.move_playlist",
    run: (execFn) =>
      createMoveOperations(execFn).movePlaylist({
        playlistId: "ABCDEF1234567890",
        targetFolderId: "AAAA1111BBBB2222",
      }),
    valid: JSON.stringify({ ...PLAYLIST_ROW, folderId: "AAAA1111BBBB2222" }),
    expected: {
      id: "ABCDEF1234567890",
      name: "Road Trip",
      isSmart: false,
      folderId: "AAAA1111BBBB2222",
      trackCount: 12,
    },
    wrongShape: JSON.stringify({ ...PLAYLIST_ROW, isSmart: "false" }),
    message: "Music returned an invalid move playlist payload.",
  },
  {
    name: "music.list_playlists",
    run: (execFn) => createPlaylistOperations(execFn).listPlaylists({}),
    valid: PLAYLIST_ENTRIES,
    after: [JSON.stringify(["AAAA1111BBBB2222"])],
    expected: [
      { id: "ABCDEF1234567890", name: "Road Trip", isSmart: false, folderId: "AAAA1111BBBB2222" },
    ],
    wrongShape: JSON.stringify([{ id: "ABCDEF1234567890", name: "Road Trip", kind: "user" }]),
    message: "Music returned an invalid playlist payload.",
  },
  {
    name: "music.create_playlist",
    run: (execFn) => createPlaylistOperations(execFn).createPlaylist({ name: "Road Trip" }),
    valid: JSON.stringify({ ...PLAYLIST_ROW, trackCount: 0 }),
    expected: { id: "ABCDEF1234567890", name: "Road Trip", isSmart: false, trackCount: 0 },
    wrongShape: JSON.stringify({ id: "ABCDEF1234567890", name: "Road Trip" }),
    message: "Music returned an invalid create playlist payload.",
  },
  {
    name: "music.get_now_playing",
    run: (execFn) => createPlaybackOperations(execFn).getNowPlaying(),
    valid: JSON.stringify({
      playerState: "paused",
      name: "Song",
      artist: "Artist",
      album: "Album",
      duration: 222.2,
      position: 5.7,
    }),
    expected: {
      name: "Song",
      artist: "Artist",
      album: "Album",
      duration: 222.2,
      position: 5.7,
      playerState: "paused",
    },
    wrongShape: JSON.stringify({
      playerState: "fast forwarding",
      name: "Song",
      artist: "Artist",
      album: "Album",
      duration: 222.2,
      position: 5.7,
    }),
    message: "Music returned an invalid now playing payload.",
  },
  {
    name: "music.playback_control",
    run: (execFn) => createPlaybackOperations(execFn).controlPlayback("pause"),
    valid: JSON.stringify({ success: true, action: "pause", playerState: "paused" }),
    expected: { success: true, action: "pause", playerState: "paused" },
    wrongShape: JSON.stringify({ success: true, action: "pause" }),
    message: "Music returned an invalid playback control payload.",
  },
];

async function errorOf(promise: Promise<unknown>): Promise<MusicToolError> {
  const error = await promise.catch((caught: unknown) => caught);
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
      expect(await run(scriptedRunner(...before, valid, ...after))).toEqual(expected);
    });

    test(`${name} rejects malformed payloads with script_error`, async () => {
      for (const payload of ["not json", "", wrongShape]) {
        const error = await errorOf(run(scriptedRunner(...before, payload, ...after)));
        expect(error.code).toBe("script_error");
        expect(error.message).toBe(message);
      }
    });
  }
});
