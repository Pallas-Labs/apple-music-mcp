# Changelog

## 0.3.0

### Added

- `music.play` starts a playlist or a track, optionally shuffled.
- `music.set_player` sets volume, shuffle, repeat, and playback position.
- `music.rename_playlist` renames a user playlist or folder.
- `music.delete_playlist` deletes a user playlist. Clients that support elicitation always show a
  confirmation prompt; other clients must pass `confirm: true`. Folders are refused.
- `music.update_track` sets a track's favorite, dislike, and star rating.
- OpenCode setup in the README. The server works with OpenCode Code Mode.
- MCP 2026-07-28 cache hints: list results and `music://guide` may be cached for one hour;
  `music://now-playing` is never cached.
- Tool arguments are limited to 512 array elements and object members.

### Changed

- `music.find_tracks` and `music.create_playlist_from_criteria` let Music filter tracks and read
  them in bulk. Searches that took 30 to 53 seconds on a 6,059-track library now take under
  3 seconds, and the 1,000-candidate window is gone. `truncated` is now true only above 50,000
  candidates.
- Every tool input field, and output fields with non-obvious meaning, now has a description.
  Each tool description starts with a summary line of at most 120 characters.
- Server instructions and `music://guide` describe result and error shapes.
- `music.capabilities` reports tool names from the server's tool registry.
- MCP TypeScript SDK updated to 2.3.1.
