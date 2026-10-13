import type { AnyToolDef } from "../tool-contracts.js";
import { capabilitiesTool } from "./capabilities.js";
import { healthTool } from "./health.js";
import { listFoldersTool, createFolderTool } from "./folders.js";
import {
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
} from "./playlists.js";
import { movePlaylistTool } from "./move.js";
import { getNowPlayingTool, playbackControlTool } from "./playback.js";
import { searchLibraryTool } from "./search.js";
import {
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
} from "./tracks.js";

export {
  capabilitiesTool,
  healthTool,
  listFoldersTool,
  createFolderTool,
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
  movePlaylistTool,
  getNowPlayingTool,
  playbackControlTool,
  searchLibraryTool,
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
};

/** Every tool, in the order the server registers and lists them. */
export const allTools: readonly AnyToolDef[] = [
  capabilitiesTool,
  healthTool,
  listFoldersTool,
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
  createFolderTool,
  movePlaylistTool,
  getNowPlayingTool,
  playbackControlTool,
  searchLibraryTool,
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
];
