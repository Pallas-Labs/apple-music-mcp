import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type ElicitRequestFormParams,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import { createMcpHandler, inputRequired, inputResponse } from "@modelcontextprotocol/server";
import { runtimeConfig } from "./config.js";
import { createServer, defineTool, toolErrorResult, type CreateServerOptions } from "./server.js";
import { MusicToolError } from "./types.js";
import {
  addTracksToPlaylistTool,
  createPlaylistFromCriteriaTool,
  createFolderTool,
  createPlaylistTool,
  movePlaylistTool,
  renamePlaylistTool,
  playbackControlTool,
  playTool,
  setPlayerTool,
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
const IDEMPOTENT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const REIDEMPOTENT_ANNOTATIONS = {
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
  "music.move_playlist": IDEMPOTENT_ANNOTATIONS,
  "music.rename_playlist": IDEMPOTENT_ANNOTATIONS,
  "music.get_now_playing": READ_ANNOTATIONS,
  "music.playback_control": ADDITIVE_ANNOTATIONS,
  "music.play": ADDITIVE_ANNOTATIONS,
  "music.set_player": IDEMPOTENT_ANNOTATIONS,
  "music.search_library": READ_ANNOTATIONS,
  "music.find_tracks": READ_ANNOTATIONS,
  "music.get_playlist_tracks": READ_ANNOTATIONS,
  "music.add_tracks_to_playlist": ADDITIVE_ANNOTATIONS,
  "music.remove_tracks_from_playlist": REIDEMPOTENT_ANNOTATIONS,
} as const;

type TestClientOptions = {
  server?: CreateServerOptions;
  /** Declares the elicitation capability and answers every elicitation request. */
  elicit?: (params: ElicitRequestFormParams) => ElicitResult;
};

function createTestClient(
  name: string,
  clientOptions: ClientOptions,
  elicit?: TestClientOptions["elicit"],
) {
  const client = new Client(
    { name, version: "1.0.0" },
    elicit ? { ...clientOptions, capabilities: { elicitation: {} } } : clientOptions,
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", (request) =>
      elicit(request.params as ElicitRequestFormParams),
    );
  }
  return client;
}

async function withMcpClient<T>(
  run: (client: Client) => Promise<T>,
  options: TestClientOptions = {},
): Promise<T> {
  const server = createServer(options.server);
  const client = createTestClient("apple-music-mcp-test", {}, options.elicit);
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

async function withModernMcpClient<T>(
  run: (client: Client) => Promise<T>,
  options: TestClientOptions = {},
): Promise<T> {
  const handler = createMcpHandler(() => createServer(options.server));
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = createTestClient(
    "apple-music-mcp-modern-test",
    { versionNegotiation: { mode: "auto" } },
    options.elicit,
  );
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await handler.close();
  }
}

const WRITES_ENABLED = Object.freeze({ writesEnabled: true, dryRun: false });

const askTool = defineTool({
  name: "test.ask",
  description: "Ask the client one question when it can elicit.",
  inputSchema: z.object({}),
  outputSchema: z.object({ canElicit: z.boolean(), answer: z.string() }),
  annotations: ADDITIVE_ANNOTATIONS,
  writesRequired: true,
  dryRunResult: () => ({ canElicit: false, answer: "dry run" }),
  async handler(_input, { canElicit, inputResponses }) {
    if (!canElicit) return { structuredContent: { canElicit, answer: "not asked" } };
    const response = inputResponse(inputResponses, "go");
    if (response.kind === "missing") {
      return inputRequired({
        inputRequests: {
          go: inputRequired.elicit({
            message: "Go?",
            requestedSchema: z.object({ go: z.boolean() }),
          }),
        },
      });
    }
    return {
      structuredContent: { canElicit, answer: response.kind === "elicit" ? response.action : "" },
    };
  },
});

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

  test("music.capabilities lists every registered tool in order", async () => {
    await withMcpClient(async (client) => {
      const response = await client.callTool({ name: "music.capabilities", arguments: {} });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent?.tools).toEqual(Object.keys(EXPECTED_ANNOTATIONS));
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

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("music.health");
      expect(instructions.length).toBeLessThanOrEqual(500);
    });
  });

  test("2026-07-28 results carry cache hints: static catalogue for an hour, now-playing never", async () => {
    await withModernMcpClient(async (client) => {
      const staticHint = { ttlMs: 3_600_000, cacheScope: "private" };
      const [tools, prompts, resources, templates, guide] = await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
        client.listResourceTemplates(),
        client.readResource({ uri: "music://guide" }),
      ]);
      for (const result of [tools, prompts, resources, templates, guide]) {
        expect(result).toMatchObject(staticHint);
      }
      expect(client.getDiscoverResult()).toMatchObject(staticHint);

      // Runs read-only AppleScript; it reports "stopped" without launching Music.
      const nowPlaying = await client.readResource({ uri: "music://now-playing" });
      expect(nowPlaying).toMatchObject({ ttlMs: 0, cacheScope: "private" });
    });
  });

  test("2025-era results carry no cache fields", async () => {
    await withMcpClient(async (client) => {
      const [tools, guide] = await Promise.all([
        client.listTools(),
        client.readResource({ uri: "music://guide" }),
      ]);
      for (const result of [tools, guide]) {
        expect(result).not.toHaveProperty("ttlMs");
        expect(result).not.toHaveProperty("cacheScope");
      }
    });
  });

  test("rejects tool arguments with more than 512 elements before the handler runs", async () => {
    const callWithElements = (client: Client, padding: number) =>
      client.callTool({
        name: "music.capabilities",
        arguments: { padding: Array.from({ length: padding }, () => 0) },
      });

    for (const withClient of [withMcpClient, withModernMcpClient]) {
      await withClient(async (client) => {
        // One object member plus 511 array elements is exactly 512.
        const atLimit = await callWithElements(client, 511);
        expect(atLimit.isError).toBeFalsy();

        const overLimit = await callWithElements(client, 512);
        expect(overLimit.isError).toBe(true);
        expect(overLimit.structuredContent).toBeUndefined();
        expect(overLimit.content).toEqual([
          {
            type: "text",
            text: "Invalid arguments for tool music.capabilities: arguments contain more than the maximum of 512 elements",
          },
        ]);
      });
    }
  });

  test("passes input-required rounds through to clients of both eras", async () => {
    for (const withClient of [withMcpClient, withModernMcpClient]) {
      const messages: string[] = [];
      const answered = await withClient(
        (client) => client.callTool({ name: "test.ask", arguments: {} }),
        {
          server: { config: WRITES_ENABLED, tools: [askTool] },
          elicit: (params) => {
            messages.push(params.message);
            return { action: "decline" };
          },
        },
      );
      expect(answered.isError).toBeFalsy();
      expect(answered.structuredContent).toEqual({ canElicit: true, answer: "decline" });
      expect(messages).toEqual(["Go?"]);

      const unasked = await withClient(
        (client) => client.callTool({ name: "test.ask", arguments: {} }),
        { server: { config: WRITES_ENABLED, tools: [askTool] } },
      );
      expect(unasked.structuredContent).toEqual({ canElicit: false, answer: "not asked" });
    }
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
        payload: renamePlaylistTool.dryRunResult({
          playlistId: "ABCDEF1234567890",
          name: "Renamed",
        }),
        outputSchema: renamePlaylistTool.outputSchema,
      },
      {
        payload: playbackControlTool.dryRunResult({ action: "play" }),
        outputSchema: playbackControlTool.outputSchema,
      },
      {
        payload: playTool.dryRunResult({ playlistId: "ABCDEF1234567890", shuffle: true }),
        outputSchema: playTool.outputSchema,
      },
      {
        payload: setPlayerTool.dryRunResult({ volume: 40, repeat: "all" }),
        outputSchema: setPlayerTool.outputSchema,
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

type JsonSchemaNode = {
  description?: string;
  properties?: Record<string, JsonSchemaNode>;
  items?: JsonSchemaNode;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
};

function undescribedProperties(schema: JsonSchemaNode, path: string): string[] {
  const nested = [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => [
      ...(property.description?.trim() ? [] : [`${path}.${name}`]),
      ...undescribedProperties(property, `${path}.${name}`),
    ]),
    ...(schema.items ? undescribedProperties(schema.items, `${path}[]`) : []),
    ...[...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])].flatMap(
      (variant) => undescribedProperties(variant, path),
    ),
  ];
  return nested;
}

// Code-mode clients such as OpenCode show only the first line of a tool description, cut at
// 120 characters, and turn property descriptions into the JSDoc of generated signatures.
describe("tool metadata for code-mode clients", () => {
  test("every input property at every depth has a description", async () => {
    await withMcpClient(async (client) => {
      const { tools } = await client.listTools();
      const missing = tools.flatMap((tool) =>
        undescribedProperties(tool.inputSchema as JsonSchemaNode, tool.name),
      );
      expect(missing).toEqual([]);
    });
  });

  test("every tool description starts with a summary line of at most 120 characters", async () => {
    await withMcpClient(async (client) => {
      const { tools } = await client.listTools();
      const tooLong = tools
        .map((tool) => ({ name: tool.name, summary: tool.description?.split("\n")[0] ?? "" }))
        .filter(({ summary }) => summary.trim().length === 0 || summary.length > 120);
      expect(tooLong).toEqual([]);
    });
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
