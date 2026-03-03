# apple-music-mcp

[![npm](https://img.shields.io/npm/v/apple-music-mcp)](https://www.npmjs.com/package/apple-music-mcp)
[![macOS only](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/parthmangrola/apple-music-mcp)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

MCP server for controlling Apple Music on macOS via AppleScript. Works with Claude Code, Codex CLI, Cursor, and any MCP-compatible client.

## Quick Start

```bash
npx -y apple-music-mcp
```

## Tools

| Tool                           | Description                                         | Read/Write |
| ------------------------------ | --------------------------------------------------- | ---------- |
| `music.capabilities`           | Report server capabilities and runtime flags        | Read       |
| `music.health`                 | Check Music availability and automation permissions | Read       |
| `music.list_folders`           | List folder playlists                               | Read       |
| `music.list_playlists`         | List user playlists, optionally filtered by folder  | Read       |
| `music.get_now_playing`        | Get current track info and player state             | Read       |
| `music.search_library`         | Search library tracks by name/artist                | Read       |
| `music.get_playlist_tracks`    | Get tracks in a playlist (paginated)                | Read       |
| `music.create_playlist`        | Create a playlist, optionally in a folder           | Write      |
| `music.create_folder`          | Create a folder playlist, optionally nested         | Write      |
| `music.move_playlist`          | Move a playlist into a folder                       | Write      |
| `music.playback_control`       | Play, pause, next, previous, toggle                 | Write      |
| `music.add_tracks_to_playlist` | Add tracks to a playlist by ID                      | Write      |

## Environment Variables

| Variable                        | Default | Description                                                    |
| ------------------------------- | ------- | -------------------------------------------------------------- |
| `APPLE_MUSIC_MCP_ENABLE_WRITES` | `false` | Enable mutation tools (create, move, playback, add tracks)     |
| `APPLE_MUSIC_MCP_DRY_RUN`       | `false` | Mutation tools return dry-run payloads without modifying Music |

## Setup (Recommended)

### Codex CLI / Codex IDE extension

Add the server with the CLI:

```bash
codex mcp add apple_music -- npx -y apple-music-mcp
```

Then set safe timeouts in `~/.codex/config.toml` (default tool timeout is 60s, but this server can take up to ~70s for large playlist operations):

```toml
[mcp_servers.apple_music]
command = "npx"
args = ["-y", "apple-music-mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 90

[mcp_servers.apple_music.env]
APPLE_MUSIC_MCP_ENABLE_WRITES = "false"
```

If you want mutation tools, set:

```toml
[mcp_servers.apple_music.env]
APPLE_MUSIC_MCP_ENABLE_WRITES = "true"
```

### Claude Code

Add the server with Claude CLI:

```bash
claude mcp add --transport stdio apple-music -- npx -y apple-music-mcp
```

`--transport`/`--env` options must come before the server name, and `--` separates Claude flags from the server command.

Project-shared setup (`.mcp.json`):

```json
{
  "mcpServers": {
    "apple-music": {
      "command": "npx",
      "args": ["-y", "apple-music-mcp"],
      "env": {
        "APPLE_MUSIC_MCP_ENABLE_WRITES": "false"
      }
    }
  }
}
```

To enable writes, set `APPLE_MUSIC_MCP_ENABLE_WRITES` to `"true"`.

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "apple-music": {
      "command": "npx",
      "args": ["-y", "apple-music-mcp"],
      "env": {
        "APPLE_MUSIC_MCP_ENABLE_WRITES": "false"
      }
    }
  }
}
```

### Hardened Read-Only (Codex)

For extra safety, keep writes disabled and hide mutation tools:

```toml
[mcp_servers.apple_music]
command = "npx"
args = ["-y", "apple-music-mcp"]
tool_timeout_sec = 90
disabled_tools = [
  "music.create_playlist",
  "music.create_folder",
  "music.move_playlist",
  "music.playback_control",
  "music.add_tracks_to_playlist"
]
```

## Permissions

This server uses AppleScript to control Music. macOS will prompt for automation permission on first use.

If you see `permission_denied` errors:

1. Open **System Settings** > **Privacy & Security** > **Automation**
2. Find your terminal app (Terminal, iTerm2, VS Code, etc.)
3. Enable **Music** under it

## Development

```bash
git clone https://github.com/parthmangrola/apple-music-mcp.git
cd apple-music-mcp
bun install
bun run format:check
bun run lint
bun run typecheck
bun test src
bun run build
```

### Integration Tests

Requires Music app running on macOS:

```bash
INTEGRATION=true bun test src
```

## Troubleshooting

**"Music app is not running or unavailable"**
The server auto-launches Music. If it fails, open Music manually first.

**"Permission denied to control Music"**
See the [Permissions](#permissions) section above.

**"AppleScript command timed out"**
Large libraries can be slow. The server uses generous timeouts (up to 70s for playlist listing). In Codex, set `tool_timeout_sec = 90` for this server. If you still hit timeouts, run `music.health` first to warm up the connection.

**Mutations are non-atomic**
AppleScript doesn't support transactions. Bulk operations (like `add_tracks_to_playlist`) may partially succeed. This is a platform limitation.

## License

MIT
