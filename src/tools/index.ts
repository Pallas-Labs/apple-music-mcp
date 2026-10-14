import type { AnyToolDef } from "../tool-contracts.js";
import { capabilitiesTool } from "./capabilities.js";
import { listFoldersTool, createFolderTool } from "./folders.js";
import { healthTool } from "./health.js";
import { updateTrackTool } from "./library.js";
import { movePlaylistTool } from "./move.js";
import {
  getNowPlayingTool,
  playbackControlTool,
  playTool,
  setPlayerTool,
} from "./playback.js";
import { deletePlaylistTool, renamePlaylistTool } from "./playlist-edits.js";
import {
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
} from "./playlists.js";
import { searchLibraryTool } from "./search.js";
import {
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
} from "./tracks.js";

export { capabilitiesTool } from "./capabilities.js";
export { listFoldersTool, createFolderTool } from "./folders.js";
export { healthTool } from "./health.js";
export { updateTrackTool } from "./library.js";
export { movePlaylistTool } from "./move.js";
export {
  getNowPlayingTool,
  playbackControlTool,
  playTool,
  setPlayerTool,
} from "./playback.js";
export { deletePlaylistTool, renamePlaylistTool } from "./playlist-edits.js";
export {
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
} from "./playlists.js";
export { searchLibraryTool } from "./search.js";
export {
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
} from "./tracks.js";

export const allTools: readonly AnyToolDef[] = [
  capabilitiesTool,
  healthTool,
  listFoldersTool,
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
  createFolderTool,
  movePlaylistTool,
  renamePlaylistTool,
  deletePlaylistTool,
  getNowPlayingTool,
  playbackControlTool,
  playTool,
  setPlayerTool,
  searchLibraryTool,
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
  updateTrackTool,
];
