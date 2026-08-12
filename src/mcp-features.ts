import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { getNowPlaying } from "./tools/playback.js";

const SERVER_GUIDE = `# Apple Music MCP guide

1. Call \`music.health\` before accessing Apple Music.
2. Use read-only tools to inspect folders, playlists, tracks, and playback.
3. Persistent IDs returned by read tools are the IDs accepted by mutation tools.
4. Write tools require \`APPLE_MUSIC_MCP_ENABLE_WRITES=true\`.
5. Set \`APPLE_MUSIC_MCP_DRY_RUN=true\` to preview write results without changing Music.
6. Bulk AppleScript mutations are non-atomic and may partially succeed; inspect the returned ID lists.
`;

export function registerResources(server: McpServer): void {
  server.registerResource(
    "apple-music-guide",
    "music://guide",
    {
      title: "Apple Music MCP guide",
      description: "Safe usage, identifiers, and write controls for this server.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: SERVER_GUIDE }],
    }),
  );

  server.registerResource(
    "now-playing",
    "music://now-playing",
    {
      title: "Now playing",
      description: "The current Apple Music track and playback state.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await getNowPlaying()),
        },
      ],
    }),
  );
}

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "curate-playlist",
    {
      title: "Curate a playlist",
      description: "Plan and create a bounded playlist from the local Apple Music library.",
      argsSchema: z.object({
        theme: z.string().trim().min(1).describe("Mood, genre, artist, era, or other theme."),
        name: z.string().trim().min(1).optional().describe("Optional playlist name."),
      }),
    },
    ({ theme, name }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Curate an Apple Music playlist around: ${theme}.`,
              name ? `Use the playlist name: ${name}.` : "Choose a concise playlist name.",
              "Call music.health first, then use music.find_tracks with explicit bounded criteria.",
              "Show the proposed tracks before creating anything unless I already approved creation.",
              "Use music.create_playlist_from_criteria only after approval and report partial failures.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "library-overview",
    {
      title: "Summarize my library",
      description: "Inspect playlists, folders, and playback without changing Apple Music.",
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: "Call music.health, music.get_now_playing, music.list_folders, and music.list_playlists. Summarize my Apple Music library and current playback. Do not call write tools.",
          },
        },
      ],
    }),
  );
}
