import { describe, expect, test } from "bun:test";

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type ClientOptions,
  type ElicitRequestFormParams,
  type ElicitResult,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { runtimeConfig } from "./config.js";
import {
  createServer,
  defineTool,
  toolErrorResult,
  type CreateServerOptions,
} from "./server.js";
import {
  addTracksToPlaylistTool,
  capabilitiesTool,
  createPlaylistFromCriteriaTool,
  createFolderTool,
  createPlaylistTool,
  movePlaylistTool,
  renamePlaylistTool,
  deletePlaylistTool,
  playbackControlTool,
  playTool,
  setPlayerTool,
  removeTracksFromPlaylistTool,
  updateTrackTool,
} from "./tools/index.js";
import {
  createDeletePlaylistTool,
  createPlaylistEditOperations,
} from "./tools/playlist-edits.js";
import { createCriteriaPlaylistTool } from "./tools/playlists.js";
import { MusicToolError } from "./types.js";

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
const DESTRUCTIVE_ANNOTATIONS = {
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
  "music.delete_playlist": DESTRUCTIVE_ANNOTATIONS,
  "music.get_now_playing": READ_ANNOTATIONS,
  "music.playback_control": ADDITIVE_ANNOTATIONS,
  "music.play": ADDITIVE_ANNOTATIONS,
  "music.set_player": IDEMPOTENT_ANNOTATIONS,
  "music.search_library": READ_ANNOTATIONS,
  "music.find_tracks": READ_ANNOTATIONS,
  "music.get_playlist_tracks": READ_ANNOTATIONS,
  "music.add_tracks_to_playlist": ADDITIVE_ANNOTATIONS,
  "music.remove_tracks_from_playlist": DESTRUCTIVE_ANNOTATIONS,
  "music.update_track": IDEMPOTENT_ANNOTATIONS,
} as const;

type TestClientOptions = {
  server?: CreateServerOptions;
  /** Declares the elicitation capability and answers every elicitation request. */
  elicit?: (params: ElicitRequestFormParams) => ElicitResult;
};

const ERAS = ["2025-era", "2026-07-28"] as const;
type Era = (typeof ERAS)[number];

/** Connect a client of the given protocol era to a fresh server, run `run`, then close both. */
async function withClient<T>(
  era: Era,
  run: (client: Client) => Promise<T>,
  options: TestClientOptions = {}
): Promise<T> {
  const { elicit } = options;
  const clientOptions: ClientOptions = {
    ...(era === "2026-07-28" ? { versionNegotiation: { mode: "auto" } } : {}),
    ...(elicit ? { capabilities: { elicitation: {} } } : {}),
  };
  const client = new Client(
    { name: "apple-music-mcp-test", version: "1.0.0" },
    clientOptions
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", (request) =>
      elicit(request.params as ElicitRequestFormParams)
    );
  }

  let closeServer: () => Promise<void>;
  if (era === "2025-era") {
    const server = createServer(options.server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeServer = () => server.close();
  } else {
    const handler = createMcpHandler(() => createServer(options.server));
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: (url, init) => handler.fetch(new Request(url, init)),
      })
    );
    closeServer = () => handler.close();
  }

  try {
    return await run(client);
  } finally {
    await client.close();
    await closeServer();
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
    if (!canElicit)
      return { structuredContent: { canElicit, answer: "not asked" } };
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
      structuredContent: {
        canElicit,
        answer: response.kind === "elicit" ? response.action : "",
      },
    };
  },
});

describe("createServer", () => {
  test("registers all tools with schemas and exact annotations", async () => {
    await withClient("2025-era", async (client) => {
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual(
        Object.keys(EXPECTED_ANNOTATIONS)
      );
      for (const tool of response.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations).toEqual(
          EXPECTED_ANNOTATIONS[tool.name as keyof typeof EXPECTED_ANNOTATIONS]
        );
      }
    });
  });

  test("music.capabilities lists every registered tool in order", async () => {
    await withClient("2025-era", async (client) => {
      const response = await client.callTool({
        name: "music.capabilities",
        arguments: {},
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent?.tools).toEqual(
        Object.keys(EXPECTED_ANNOTATIONS)
      );
    });
  });

  test("music.capabilities reports the tools and config the server was created with", async () => {
    const config = { writesEnabled: true, dryRun: true };
    const response = await withClient(
      "2025-era",
      (client) =>
        client.callTool({ name: "music.capabilities", arguments: {} }),
      { server: { config, tools: [askTool, capabilitiesTool] } }
    );
    expect(response.structuredContent).toMatchObject({
      writesEnabled: true,
      dryRun: true,
      tools: ["test.ask", "music.capabilities"],
    });
  });

  test.skipIf(runtimeConfig.writesEnabled)(
    "rejects writes before executing AppleScript",
    async () => {
      await withClient("2025-era", async (client) => {
        const response = await client.callTool({
          name: "music.create_playlist",
          arguments: { name: "Must Not Be Created" },
        });
        expect(response.isError).toBe(true);
        const content = response.content[0];
        expect(content?.type).toBe("text");
        if (!content || content.type !== "text")
          throw new Error("Expected text error content.");
        expect(JSON.parse(content.text)).toEqual({
          code: "validation_error",
          message:
            "Writes are disabled. Set APPLE_MUSIC_MCP_ENABLE_WRITES=true to enable mutation tools.",
        });
      });
    }
  );

  test("serves the 2026-07-28 protocol with tools, resources, and prompts", async () => {
    await withClient("2026-07-28", async (client) => {
      expect(client.getProtocolEra()).toBe("modern");

      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResources(),
        client.listPrompts(),
      ]);

      expect(tools.tools).toHaveLength(
        Object.keys(EXPECTED_ANNOTATIONS).length
      );
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

  test("2026-07-28 results carry cache hints for the static catalogue", async () => {
    await withClient("2026-07-28", async (client) => {
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
    });
  });

  test("2025-era results carry no cache fields", async () => {
    await withClient("2025-era", async (client) => {
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

    for (const era of ERAS) {
      await withClient(era, async (client) => {
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
    for (const era of ERAS) {
      const messages: string[] = [];
      const answered = await withClient(
        era,
        (client) => client.callTool({ name: "test.ask", arguments: {} }),
        {
          server: { config: WRITES_ENABLED, tools: [askTool] },
          elicit: (params) => {
            messages.push(params.message);
            return { action: "decline" };
          },
        }
      );
      expect(answered.isError).toBeFalsy();
      expect(answered.structuredContent).toEqual({
        canElicit: true,
        answer: "decline",
      });
      expect(messages).toEqual(["Go?"]);

      const unasked = await withClient(
        era,
        (client) => client.callTool({ name: "test.ask", arguments: {} }),
        { server: { config: WRITES_ENABLED, tools: [askTool] } }
      );
      expect(unasked.structuredContent).toEqual({
        canElicit: false,
        answer: "not asked",
      });
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
        payload: deletePlaylistTool.dryRunResult({
          playlistId: "ABCDEF1234567890",
        }),
        outputSchema: deletePlaylistTool.outputSchema,
      },
      {
        payload: playbackControlTool.dryRunResult({ action: "play" }),
        outputSchema: playbackControlTool.outputSchema,
      },
      {
        payload: playTool.dryRunResult({
          playlistId: "ABCDEF1234567890",
          shuffle: true,
        }),
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
      {
        payload: updateTrackTool.dryRunResult({
          trackId: "AAAABBBBCCCCDDDD",
          disliked: true,
        }),
        outputSchema: updateTrackTool.outputSchema,
      },
    ];

    for (const { payload, outputSchema } of cases) {
      expect(outputSchema.safeParse(payload).success).toBe(true);
    }
  });
});

describe("mutation lock scope", () => {
  const PLAYLIST_ID = "ABCDEF1234567890";
  const TRACK_ID = "AAAABBBBCCCCDDDD";
  const CRITERIA_ARGS = { name: "Eno", criteria: { artist: "Brian Eno" } };

  /** A write tool with the default call-wide lock that runs only when `release` is called. */
  function gatedWriteTool(events: string[]) {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const tool = defineTool({
      name: "test.write",
      description: "Write after the test releases the gate.",
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      annotations: ADDITIVE_ANNOTATIONS,
      writesRequired: true,
      dryRunResult: () => ({ ok: false }),
      async handler() {
        events.push("other write start");
        started.resolve();
        await gate.promise;
        events.push("other write end");
        return { structuredContent: { ok: true } };
      },
    });
    return { tool, started: started.promise, release: () => gate.resolve() };
  }

  function criteriaTool(
    events: string[],
    scanGate: Promise<void> = Promise.resolve()
  ) {
    const scanStarted = Promise.withResolvers<void>();
    const tool = createCriteriaPlaylistTool({
      async findTracks() {
        events.push("scan start");
        scanStarted.resolve();
        await scanGate;
        events.push("scan end");
        return {
          tracks: [
            {
              id: TRACK_ID,
              name: "An Ending",
              artist: "Brian Eno",
              album: "Apollo",
              genre: "Ambient",
              duration: 266,
              year: 1983,
              playCount: 3,
            },
          ],
          totalMatched: 1,
          limit: 1,
          scanned: 1,
          truncated: false,
        };
      },
      async createPlaylist({ name }) {
        events.push("create");
        return { id: PLAYLIST_ID, name, isSmart: false, trackCount: 0 };
      },
      async addTracksToPlaylist(playlistId, trackIds) {
        events.push("add");
        return {
          playlistId,
          requested: trackIds.length,
          added: trackIds.length,
          addedTrackIds: trackIds,
          missingTrackIds: [],
          failedTrackIds: [],
        };
      },
    });
    return { tool, scanStarted: scanStarted.promise };
  }

  test("another write runs while create_playlist_from_criteria is still scanning", async () => {
    const events: string[] = [];
    const scanGate = Promise.withResolvers<void>();
    const criteria = criteriaTool(events, scanGate.promise);
    const other = gatedWriteTool(events);
    other.release();

    await withClient(
      "2025-era",
      async (client) => {
        const pending = client.callTool({
          name: "music.create_playlist_from_criteria",
          arguments: CRITERIA_ARGS,
        });
        await criteria.scanStarted;

        const write = await client.callTool({
          name: "test.write",
          arguments: {},
        });
        expect(write.structuredContent).toEqual({ ok: true });
        expect(events).toEqual([
          "scan start",
          "other write start",
          "other write end",
        ]);

        scanGate.resolve();
        const created = await pending;
        expect(created.isError).toBeFalsy();
        expect(created.structuredContent).toMatchObject({
          playlist: { id: PLAYLIST_ID, name: "Eno", trackCount: 1 },
          addedTrackIds: [TRACK_ID],
        });
      },
      { server: { config: WRITES_ENABLED, tools: [criteria.tool, other.tool] } }
    );
    expect(events.slice(3)).toEqual(["scan end", "create", "add"]);
  });

  test("create_playlist_from_criteria waits for the lock before it creates the playlist", async () => {
    const events: string[] = [];
    const criteria = criteriaTool(events);
    const other = gatedWriteTool(events);

    await withClient(
      "2025-era",
      async (client) => {
        const write = client.callTool({ name: "test.write", arguments: {} });
        await other.started;
        const created = client.callTool({
          name: "music.create_playlist_from_criteria",
          arguments: CRITERIA_ARGS,
        });
        await criteria.scanStarted;
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(events).toEqual(["other write start", "scan start", "scan end"]);

        other.release();
        await Promise.all([write, created]);
      },
      { server: { config: WRITES_ENABLED, tools: [criteria.tool, other.tool] } }
    );
    expect(events.slice(3)).toEqual(["other write end", "create", "add"]);
  });
});

describe("music.delete_playlist confirmation", () => {
  const PLAYLIST_ID = "ABCDEF1234567890";

  function deleteServer(
    kind: "user" | "folder" = "user",
    config = WRITES_ENABLED
  ) {
    const deletedIds: string[] = [];
    const operations = createPlaylistEditOperations(async (script) => {
      const deleting = script.includes("delete p");
      if (deleting) deletedIds.push(PLAYLIST_ID);
      return {
        stdout: JSON.stringify({
          found: true,
          id: PLAYLIST_ID,
          name: "Road Trip",
          kind,
          isSmart: false,
          trackCount: 12,
          folderId: "",
          applied: deleting,
        }),
        stderr: "",
      };
    });
    return {
      deletedIds,
      server: { config, tools: [createDeletePlaylistTool(operations)] },
    };
  }

  function callDelete(client: Client, args: Record<string, unknown> = {}) {
    return client.callTool({
      name: "music.delete_playlist",
      arguments: { playlistId: PLAYLIST_ID, ...args },
    });
  }

  function errorPayload(response: Awaited<ReturnType<typeof callDelete>>) {
    expect(response.isError).toBe(true);
    const content = response.content[0];
    if (!content || content.type !== "text")
      throw new Error("Expected text error content.");
    return JSON.parse(content.text) as { code: string; message: string };
  }

  for (const era of ERAS) {
    test(`${era} client with elicitation deletes only after the user accepts`, async () => {
      const { deletedIds, server } = deleteServer();
      const prompts: string[] = [];
      // confirm: true must not skip the prompt when the client can show one.
      const accepted = await withClient(
        era,
        (client) => callDelete(client, { confirm: true }),
        {
          server,
          elicit: (params) => {
            prompts.push(params.message);
            return { action: "accept", content: { confirm: true } };
          },
        }
      );
      expect(accepted.isError).toBeFalsy();
      expect(accepted.structuredContent).toEqual({
        deletedPlaylistId: PLAYLIST_ID,
        name: "Road Trip",
      });
      expect(deletedIds).toEqual([PLAYLIST_ID]);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain('"Road Trip" (12 tracks)');
    });

    test(`${era} client that declines or unticks the prompt deletes nothing`, async () => {
      const answers: ElicitResult[] = [
        { action: "decline" },
        { action: "cancel" },
        { action: "accept", content: { confirm: false } },
      ];
      for (const answer of answers) {
        const { deletedIds, server } = deleteServer();
        const response = await withClient(era, (client) => callDelete(client), {
          server,
          elicit: () => answer,
        });
        expect(errorPayload(response)).toEqual({
          code: "validation_error",
          message: "Deletion cancelled. Nothing was deleted.",
        });
        expect(deletedIds).toEqual([]);
      }
    });

    test(`${era} client without elicitation must pass confirm: true`, async () => {
      const unconfirmed = deleteServer();
      const refused = await withClient(era, (client) => callDelete(client), {
        server: unconfirmed.server,
      });
      const error = errorPayload(refused);
      expect(error.code).toBe("validation_error");
      expect(error.message).toContain("confirm: true");
      expect(unconfirmed.deletedIds).toEqual([]);

      const confirmed = deleteServer();
      const deleted = await withClient(
        era,
        (client) => callDelete(client, { confirm: true }),
        {
          server: confirmed.server,
        }
      );
      expect(deleted.structuredContent).toEqual({
        deletedPlaylistId: PLAYLIST_ID,
        name: "Road Trip",
      });
      expect(confirmed.deletedIds).toEqual([PLAYLIST_ID]);
    });
  }

  test("refuses folders before prompting", async () => {
    const { deletedIds, server } = deleteServer("folder");
    const prompts: string[] = [];
    const response = await withClient(
      "2025-era",
      (client) => callDelete(client, { confirm: true }),
      {
        server,
        elicit: (params) => {
          prompts.push(params.message);
          return { action: "accept", content: { confirm: true } };
        },
      }
    );
    const error = errorPayload(response);
    expect(error.code).toBe("validation_error");
    expect(error.message).toStartWith('"Road Trip" is a folder.');
    expect(prompts).toEqual([]);
    expect(deletedIds).toEqual([]);
  });

  test("dry run returns the preview without prompting or deleting", async () => {
    const { deletedIds, server } = deleteServer("user", {
      writesEnabled: true,
      dryRun: true,
    });
    const prompts: string[] = [];
    const response = await withClient(
      "2025-era",
      (client) => callDelete(client),
      {
        server,
        elicit: (params) => {
          prompts.push(params.message);
          return { action: "accept", content: { confirm: true } };
        },
      }
    );
    expect(response.structuredContent).toEqual({
      deletedPlaylistId: PLAYLIST_ID,
      name: "DRY_RUN_PLAYLIST",
    });
    expect(prompts).toEqual([]);
    expect(deletedIds).toEqual([]);
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
    ...[
      ...(schema.anyOf ?? []),
      ...(schema.oneOf ?? []),
      ...(schema.allOf ?? []),
    ].flatMap((variant) => undescribedProperties(variant, path)),
  ];
  return nested;
}

// Code-mode clients such as OpenCode show only the first line of a tool description, cut at
// 120 characters, and turn property descriptions into the JSDoc of generated signatures.
describe("tool metadata for code-mode clients", () => {
  test("every input property at every depth has a description", async () => {
    await withClient("2025-era", async (client) => {
      const { tools } = await client.listTools();
      const missing = tools.flatMap((tool) =>
        undescribedProperties(tool.inputSchema as JsonSchemaNode, tool.name)
      );
      expect(missing).toEqual([]);
    });
  });

  test("every tool description starts with a summary line of at most 120 characters", async () => {
    await withClient("2025-era", async (client) => {
      const { tools } = await client.listTools();
      const tooLong = tools
        .map((tool) => ({
          name: tool.name,
          summary: tool.description?.split("\n")[0] ?? "",
        }))
        .filter(
          ({ summary }) => summary.trim().length === 0 || summary.length > 120
        );
      expect(tooLong).toEqual([]);
    });
  });
});

describe("toolErrorResult", () => {
  test("omits internal details from known errors", () => {
    const result = toolErrorResult(
      new MusicToolError("script_error", "Public message", {
        sentinelDetails: "SECRET_DETAILS",
      })
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
