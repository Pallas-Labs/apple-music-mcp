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
- `music.add_tracks_to_playlist` resolves all IDs with one library read: 10 IDs went from 7.0 s
  to 0.7 s, and 100 or 200 IDs finish (16 s and 34 s) instead of timing out.
- `music.remove_tracks_from_playlist` reads playlist IDs in bulk, so removing a few tracks from a
  large playlist no longer reads every entry. Removing many instances is still bound by Music's
  per-track delete.
- `music.get_playlist_tracks` reads each page in bulk: a 100-track page went from 9.4 s to 0.4 s.
- `music.list_playlists` and `music.list_folders` read playlist fields in bulk and read parent
  folders in four parallel scripts. On 499 playlists and 59 folders, `music.list_playlists` went
  from 42 s to 3.7 s, `music.list_folders` from 3.2 s to 1.0 s, and `includeEmpty: false` finishes
  in 4.1 s instead of timing out.
- `music.create_playlist_from_criteria` searches without holding the write lock, so other writes
  can proceed during the search.
- Playback tools poll the player state instead of waiting a fixed delay.
- Every script result is validated against the tool's output schema; malformed output returns
  `script_error`.
- `music.capabilities` and `music.health` report the configuration the server was created with.
- Every tool input field, and output fields with non-obvious meaning, now has a description.
  Each tool description starts with a summary line of at most 120 characters.
- Server instructions and `music://guide` describe result and error shapes.
- MCP TypeScript SDK updated to 2.3.1.
