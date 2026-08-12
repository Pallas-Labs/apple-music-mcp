import { describe, expect, test } from "bun:test";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { runtimeConfig } from "./config.js";
import { createServer, toolErrorResult } from "./server.js";
import { MusicToolError } from "./types.js";
import {
  addTracksToPlaylistTool,
  createPlaylistFromCriteriaTool,
  createFolderTool,
  createPlaylistTool,
  movePlaylistTool,
  playbackControlTool,
  removeTracksFromPlaylistTool,
} from "./tools/index.js";

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const ADDITIVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
const MOVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const REMOVE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const EXPECTED_ANNOTATIONS = {
  "music.capabilities": READ_ANNOTATIONS,
  "music.health": READ_ANNOTATIONS,
  "music.list_folders": READ_ANNOTATIONS,
  "music.list_playlists": READ_ANNOTATIONS,
  "music.create_playlist": ADDITIVE_ANNOTATIONS,
  "music.create_playlist_from_criteria": ADDITIVE_ANNOTATIONS,
  "music.create_folder": ADDITIVE_ANNOTATIONS,
  "music.move_playlist": MOVE_ANNOTATIONS,
  "music.get_now_playing": READ_ANNOTATIONS,
  "music.playback_control": ADDITIVE_ANNOTATIONS,
  "music.search_library": READ_ANNOTATIONS,
  "music.find_tracks": READ_ANNOTATIONS,
  "music.get_playlist_tracks": READ_ANNOTATIONS,
  "music.add_tracks_to_playlist": ADDITIVE_ANNOTATIONS,
  "music.remove_tracks_from_playlist": REMOVE_ANNOTATIONS,
} as const;

async function withMcpClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const server = createServer();
  const client = new Client({ name: "apple-music-mcp-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function withModernMcpClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const handler = createMcpHandler(createServer);
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client(
    { name: "apple-music-mcp-modern-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

describe("createServer", () => {
  test("registers all tools with schemas and exact annotations", async () => {
    await withMcpClient(async (client) => {
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
      for (const tool of response.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations).toEqual(
          EXPECTED_ANNOTATIONS[tool.name as keyof typeof EXPECTED_ANNOTATIONS],
        );
      }
    });
  });

  test.skipIf(runtimeConfig.writesEnabled)(
    "rejects writes before executing AppleScript",
    async () => {
      await withMcpClient(async (client) => {
        const response = await client.callTool({
          name: "music.create_playlist",
          arguments: { name: "Must Not Be Created" },
        });
        expect(response.isError).toBe(true);
        const content = response.content[0];
        expect(content?.type).toBe("text");
        if (!content || content.type !== "text") throw new Error("Expected text error content.");
        expect(JSON.parse(content.text)).toEqual({
          code: "validation_error",
          message:
            "Writes are disabled. Set APPLE_MUSIC_MCP_ENABLE_WRITES=true to enable mutation tools.",
        });
      });
    },
  );

  test("serves the 2026-07-28 protocol with tools, resources, and prompts", async () => {
    await withModernMcpClient(async (client) => {
      expect(client.getProtocolEra()).toBe("modern");

      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);

      expect(tools.tools).toHaveLength(Object.keys(EXPECTED_ANNOTATIONS).length);
      expect(tools.tools.every((tool) => Boolean(tool.title))).toBe(true);
      expect(resources.resources.map((resource) => resource.uri)).toEqual([
        "music://guide",
        "music://now-playing",
      ]);
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
        "curate-playlist",
        "library-overview",
      ]);

      const guide = await client.readResource({ uri: "music://guide" });
      expect(guide.contents[0]?.text).toContain("music.health");
    });
  });

  test("write tools provide exact dry-run payloads matching output schemas", () => {
    const cases = [
      {
        payload: createPlaylistTool.dryRunResult({
          name: "Dry Run Playlist",
          folderId: "ABCDEF1234567890",
        }),
        outputSchema: createPlaylistTool.outputSchema,
      },
      {
        payload: createFolderTool.dryRunResult({
          name: "Dry Run Folder",
          parentId: "ABCDEF1234567890",
        }),
        outputSchema: createFolderTool.outputSchema,
      },
      {
        payload: movePlaylistTool.dryRunResult({
          playlistId: "ABCDEF1234567890",
          targetFolderId: "12345678ABCDEFGH",
        }),
        outputSchema: movePlaylistTool.outputSchema,
      },
      {
        payload: playbackControlTool.dryRunResult({ action: "play" }),
        outputSchema: playbackControlTool.outputSchema,
      },
      {
        payload: addTracksToPlaylistTool.dryRunResult({
          playlistId: "ABCDEF1234567890",
          trackIds: ["1111222233334444", "AAAABBBBCCCCDDDD"],
        }),
        outputSchema: addTracksToPlaylistTool.outputSchema,
      },
      {
        payload: removeTracksFromPlaylistTool.dryRunResult({
          playlistId: "ABCDEF1234567890",
          trackIds: ["1111222233334444", "AAAABBBBCCCCDDDD"],
        }),
        outputSchema: removeTracksFromPlaylistTool.outputSchema,
      },
      {
        payload: createPlaylistFromCriteriaTool.dryRunResult({
          name: "Curated Set",
          criteria: {
            artist: "Brian Eno",
            yearMin: 1970,
            yearMax: 1980,
            limit: 25,
            sortBy: "playCount",
          },
        }),
        outputSchema: createPlaylistFromCriteriaTool.outputSchema,
      },
    ];

    for (const { payload, outputSchema } of cases) {
      expect(outputSchema.safeParse(payload).success).toBe(true);
    }
  });
});

describe("toolErrorResult", () => {
  test("omits internal details from known errors", () => {
    const result = toolErrorResult(
      new MusicToolError("script_error", "Public message", { sentinelDetails: "SECRET_DETAILS" }),
    );
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: "script_error",
      message: "Public message",
    });
    expect(result.content[0].text).not.toContain("SECRET_DETAILS");
  });

  test("replaces unknown exception messages", () => {
    const result = toolErrorResult(new Error("SECRET_EXCEPTION"));
    expect(JSON.parse(result.content[0].text)).toEqual({
      code: "script_error",
      message: "An unexpected server error occurred.",
    });
    expect(result.content[0].text).not.toContain("SECRET_EXCEPTION");
  });
});
