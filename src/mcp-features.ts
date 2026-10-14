import type { CacheHint, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { getNowPlaying } from "./tools/playback.js";

// The catalogue is fixed for the process lifetime: env flags are read once at startup.
export const STATIC_CATALOGUE_CACHE_HINT = Object.freeze({
  cacheScope: "private",
  ttlMs: 3_600_000,
} satisfies CacheHint);

const LIVE_CACHE_HINT = Object.freeze({
  cacheScope: "private",
  ttlMs: 0,
} satisfies CacheHint);

const SERVER_GUIDE = `# Apple Music MCP guide

1. Call \`music.health\` before accessing Apple Music.
2. Use read-only tools to inspect folders, playlists, tracks, and playback.
3. Persistent IDs returned by read tools are the IDs accepted by mutation tools.
4. Write tools require \`APPLE_MUSIC_MCP_ENABLE_WRITES=true\`.
5. Set \`APPLE_MUSIC_MCP_DRY_RUN=true\` to preview write results without changing Music.
6. Bulk AppleScript mutations are non-atomic and may partially succeed; inspect the returned ID lists.
7. Each successful result is \`structuredContent\` that matches the tool's \`outputSchema\`.
8. Errors set \`isError\`. Errors raised by this server return JSON text \`{"code": "...", "message": "..."}\`; SDK input validation errors are plain text.
9. Clients that run tools from code should chain read calls in one script and pass persistent IDs between tools.
10. \`music.delete_playlist\` asks the user to confirm when the client supports elicitation. Other clients must pass \`confirm: true\`, and only after the user approves.
`;

export const registerResources = (server: McpServer): void => {
  server.registerResource(
    "apple-music-guide",
    "music://guide",
    {
      cacheHint: STATIC_CATALOGUE_CACHE_HINT,
      description:
        "Safe usage, identifiers, and write controls for this server.",
      mimeType: "text/markdown",
      title: "Apple Music MCP guide",
    },
    (uri) => ({
      contents: [
        { mimeType: "text/markdown", text: SERVER_GUIDE, uri: uri.href },
      ],
    })
  );

  server.registerResource(
    "now-playing",
    "music://now-playing",
    {
      cacheHint: LIVE_CACHE_HINT,
      description: "The current Apple Music track and playback state.",
      mimeType: "application/json",
      title: "Now playing",
    },
    async (uri) => ({
      contents: [
        {
          mimeType: "application/json",
          text: JSON.stringify(await getNowPlaying()),
          uri: uri.href,
        },
      ],
    })
  );
};

export const registerPrompts = (server: McpServer): void => {
  server.registerPrompt(
    "curate-playlist",
    {
      // Built in two steps so `theme`, the required argument, stays first in prompts/list.
      argsSchema: z
        .object({
          theme: z
            .string()
            .trim()
            .min(1)
            .describe("Mood, genre, artist, era, or other theme."),
        })
        .extend({
          name: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe("Optional playlist name."),
        }),
      description:
        "Plan and create a bounded playlist from the local Apple Music library.",
      title: "Curate a playlist",
    },
    ({ theme, name }) => ({
      messages: [
        {
          content: {
            text: [
              `Curate an Apple Music playlist around: ${theme}.`,
              name === undefined
                ? "Choose a concise playlist name."
                : `Use the playlist name: ${name}.`,
              "Call music.health first, then use music.find_tracks with explicit bounded criteria.",
              "Show the proposed tracks before creating anything unless I already approved creation.",
              "Use music.create_playlist_from_criteria only after approval and report partial failures.",
            ].join("\n"),
            type: "text" as const,
          },
          role: "user" as const,
        },
      ],
    })
  );

  server.registerPrompt(
    "library-overview",
    {
      description:
        "Inspect playlists, folders, and playback without changing Apple Music.",
      title: "Summarize my library",
    },
    () => ({
      messages: [
        {
          content: {
            text: "Call music.health, music.get_now_playing, music.list_folders, and music.list_playlists. Summarize my Apple Music library and current playback. Do not call write tools.",
            type: "text" as const,
          },
          role: "user" as const,
        },
      ],
    })
  );
};
