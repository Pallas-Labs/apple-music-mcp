import { describe, expect, test } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";

import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import type {
  ClientOptions,
  ElicitRequestFormParams,
  ElicitResult,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { runtimeConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { createServer, defineTool, toolErrorResult } from "./server.js";
import type { CreateServerOptions, ToolDef } from "./server.js";
import type { ToolSchema, ToolSchemaOutput } from "./tool-contracts.js";
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
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};
const ADDITIVE_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  readOnlyHint: false,
};
const IDEMPOTENT_ANNOTATIONS = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
};
const DESTRUCTIVE_ANNOTATIONS = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: false,
};

/** The order clients see tools in, from tools/list and music.capabilities. */
const TOOL_ORDER = [
  "music.capabilities",
  "music.health",
  "music.list_folders",
  "music.list_playlists",
  "music.create_playlist",
  "music.create_playlist_from_criteria",
  "music.create_folder",
  "music.move_playlist",
  "music.rename_playlist",
  "music.delete_playlist",
  "music.get_now_playing",
  "music.playback_control",
  "music.play",
  "music.set_player",
  "music.search_library",
  "music.find_tracks",
  "music.get_playlist_tracks",
  "music.add_tracks_to_playlist",
  "music.remove_tracks_from_playlist",
  "music.update_track",
];

const EXPECTED_ANNOTATIONS = new Map([
  ["music.add_tracks_to_playlist", ADDITIVE_ANNOTATIONS],
  ["music.capabilities", READ_ANNOTATIONS],
  ["music.create_folder", ADDITIVE_ANNOTATIONS],
  ["music.create_playlist", ADDITIVE_ANNOTATIONS],
  ["music.create_playlist_from_criteria", ADDITIVE_ANNOTATIONS],
  ["music.delete_playlist", DESTRUCTIVE_ANNOTATIONS],
  ["music.find_tracks", READ_ANNOTATIONS],
  ["music.get_now_playing", READ_ANNOTATIONS],
  ["music.get_playlist_tracks", READ_ANNOTATIONS],
  ["music.health", READ_ANNOTATIONS],
  ["music.list_folders", READ_ANNOTATIONS],
  ["music.list_playlists", READ_ANNOTATIONS],
  ["music.move_playlist", IDEMPOTENT_ANNOTATIONS],
  ["music.play", ADDITIVE_ANNOTATIONS],
  ["music.playback_control", ADDITIVE_ANNOTATIONS],
  ["music.remove_tracks_from_playlist", DESTRUCTIVE_ANNOTATIONS],
  ["music.rename_playlist", IDEMPOTENT_ANNOTATIONS],
  ["music.search_library", READ_ANNOTATIONS],
  ["music.set_player", IDEMPOTENT_ANNOTATIONS],
  ["music.update_track", IDEMPOTENT_ANNOTATIONS],
]);

interface TestClientOptions {
  server?: CreateServerOptions;
  /** Declares the elicitation capability and answers every elicitation request. */
  elicit?: (params: ElicitRequestFormParams) => ElicitResult;
}

const ERAS = ["2025-era", "2026-07-28"] as const;
type Era = (typeof ERAS)[number];

/** Connect a client of the given protocol era to a fresh server, run `run`, then close both. */
const withClient = async <T>(
  era: Era,
  run: (client: Client) => Promise<T>,
  options: TestClientOptions = {}
): Promise<T> => {
  const { elicit } = options;
  const clientOptions: ClientOptions = {};
  if (era === "2026-07-28") {
    clientOptions.versionNegotiation = { mode: "auto" };
  }
  if (elicit) {
    clientOptions.capabilities = { elicitation: {} };
  }
  const client = new Client(
    { name: "apple-music-mcp-test", version: "1.0.0" },
    clientOptions
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", ({ params }) => {
      if (params.mode === "url") {
        throw new Error("The test client answers only form elicitation.");
      }
      return elicit(params);
    });
  }

  let closeServer: () => Promise<void>;
  if (era === "2025-era") {
    const server = createServer(options.server);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    closeServer = async () => {
      await server.close();
    };
  } else {
    const handler = createMcpHandler(() => createServer(options.server));
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch: async (url, init) => await handler.fetch(new Request(url, init)),
      })
    );
    closeServer = async () => {
      await handler.close();
    };
  }

  try {
    return await run(client);
  } finally {
    await client.close();
    await closeServer();
  }
};

const WRITES_ENABLED = Object.freeze({ dryRun: false, writesEnabled: true });

const ErrorPayloadSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
});

const askTool = defineTool({
  annotations: ADDITIVE_ANNOTATIONS,
  description: "Ask the client one question when it can elicit.",
  dryRunResult: () => ({ answer: "dry run", canElicit: false }),
  async handler(_input, { canElicit, inputResponses }) {
    if (!canElicit) {
      return await Promise.resolve({
        structuredContent: { answer: "not asked", canElicit },
      });
    }
    const response = inputResponse(inputResponses, "go");
    if (response.kind === "missing") {
      return await Promise.resolve(
        inputRequired({
          inputRequests: {
            go: inputRequired.elicit({
              message: "Go?",
              requestedSchema: z.object({ go: z.boolean() }),
            }),
          },
        })
      );
    }
    return await Promise.resolve({
      structuredContent: {
        answer: response.kind === "elicit" ? response.action : "",
        canElicit,
      },
    });
  },
  inputSchema: z.object({}),
  name: "test.ask",
  outputSchema: z.object({ answer: z.string(), canElicit: z.boolean() }),
  writesRequired: true,
});

const callWithElements = async (client: Client, padding: number) =>
  await client.callTool({
    arguments: { padding: Array.from({ length: padding }, () => 0) },
    name: "music.capabilities",
  });

/** Runs a write tool's dry run and pairs the payload with the schema it must match. */
const dryRunCase = <Input extends ToolSchema, Output extends ToolSchema>(
  tool: ToolDef<Input, Output>,
  input: ToolSchemaOutput<Input>
) => {
  if (!tool.writesRequired) {
    throw new Error(`${tool.name} is not a write tool.`);
  }
  return { outputSchema: tool.outputSchema, payload: tool.dryRunResult(input) };
};

describe("createServer", () => {
  test("registers all tools with schemas and exact annotations", async () => {
    await withClient("2025-era", async (client) => {
      const response = await client.listTools();
      expect(response.tools.map((tool) => tool.name)).toEqual(TOOL_ORDER);
      expect(new Set(EXPECTED_ANNOTATIONS.keys())).toEqual(new Set(TOOL_ORDER));
      for (const tool of response.tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations).toEqual(EXPECTED_ANNOTATIONS.get(tool.name));
      }
    });
  });

  test("music.capabilities lists every registered tool in order", async () => {
    await withClient("2025-era", async (client) => {
      const response = await client.callTool({
        arguments: {},
        name: "music.capabilities",
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toHaveProperty("tools", TOOL_ORDER);
    });
  });

  test("music.capabilities reports the tools and config the server was created with", async () => {
    const config = { dryRun: true, writesEnabled: true };
    const response = await withClient(
      "2025-era",
      async (client) =>
        await client.callTool({ arguments: {}, name: "music.capabilities" }),
      { server: { config, tools: [askTool, capabilitiesTool] } }
    );
    expect(response.structuredContent).toMatchObject({
      dryRun: true,
      tools: ["test.ask", "music.capabilities"],
      writesEnabled: true,
    });
  });

  test.skipIf(runtimeConfig.writesEnabled)(
    "rejects writes before executing AppleScript",
    async () => {
      await withClient("2025-era", async (client) => {
        const response = await client.callTool({
          arguments: { name: "Must Not Be Created" },
          name: "music.create_playlist",
        });
        expect(response.isError).toBe(true);
        const [content] = response.content;
        expect(content?.type).toBe("text");
        if (!content || content.type !== "text") {
          throw new Error("Expected text error content.");
        }
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

      expect(tools.tools).toHaveLength(EXPECTED_ANNOTATIONS.size);
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
      const [guideContent] = guide.contents;
      expect(
        guideContent && "text" in guideContent ? guideContent.text : ""
      ).toContain("music.health");

      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("music.health");
      expect(instructions.length).toBeLessThanOrEqual(500);
    });
  });

  test("2026-07-28 results carry cache hints for the static catalogue", async () => {
    await withClient("2026-07-28", async (client) => {
      const staticHint = { cacheScope: "private", ttlMs: 3_600_000 };
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

  for (const era of ERAS) {
    test(`rejects ${era} tool arguments with more than 512 elements before the handler runs`, async () => {
      await withClient(era, async (client) => {
        // One object member plus 511 array elements is exactly 512.
        const atLimit = await callWithElements(client, 511);
        expect(atLimit.isError).toBeFalsy();

        const overLimit = await callWithElements(client, 512);
        expect(overLimit.isError).toBe(true);
        expect(overLimit.structuredContent).toBeUndefined();
        expect(overLimit.content).toEqual([
          {
            text: "Invalid arguments for tool music.capabilities: arguments contain more than the maximum of 512 elements",
            type: "text",
          },
        ]);
      });
    });

    test(`passes input-required rounds through to ${era} clients`, async () => {
      const messages: string[] = [];
      const answered = await withClient(
        era,
        async (client) =>
          await client.callTool({ arguments: {}, name: "test.ask" }),
        {
          elicit: (params) => {
            messages.push(params.message);
            return { action: "decline" };
          },
          server: { config: WRITES_ENABLED, tools: [askTool] },
        }
      );
      expect(answered.isError).toBeFalsy();
      expect(answered.structuredContent).toEqual({
        answer: "decline",
        canElicit: true,
      });
      expect(messages).toEqual(["Go?"]);

      const unasked = await withClient(
        era,
        async (client) =>
          await client.callTool({ arguments: {}, name: "test.ask" }),
        { server: { config: WRITES_ENABLED, tools: [askTool] } }
      );
      expect(unasked.structuredContent).toEqual({
        answer: "not asked",
        canElicit: false,
      });
    });
  }

  test("write tools provide exact dry-run payloads matching output schemas", () => {
    const cases = [
      dryRunCase(createPlaylistTool, {
        folderId: "ABCDEF1234567890",
        name: "Dry Run Playlist",
      }),
      dryRunCase(createFolderTool, {
        name: "Dry Run Folder",
        parentId: "ABCDEF1234567890",
      }),
      dryRunCase(movePlaylistTool, {
        playlistId: "ABCDEF1234567890",
        targetFolderId: "12345678ABCDEFGH",
      }),
      dryRunCase(renamePlaylistTool, {
        name: "Renamed",
        playlistId: "ABCDEF1234567890",
      }),
      dryRunCase(deletePlaylistTool, { playlistId: "ABCDEF1234567890" }),
      dryRunCase(playbackControlTool, { action: "play" }),
      dryRunCase(playTool, { playlistId: "ABCDEF1234567890", shuffle: true }),
      dryRunCase(setPlayerTool, { repeat: "all", volume: 40 }),
      dryRunCase(addTracksToPlaylistTool, {
        playlistId: "ABCDEF1234567890",
        trackIds: ["1111222233334444", "AAAABBBBCCCCDDDD"],
      }),
      dryRunCase(removeTracksFromPlaylistTool, {
        playlistId: "ABCDEF1234567890",
        trackIds: ["1111222233334444", "AAAABBBBCCCCDDDD"],
      }),
      dryRunCase(createPlaylistFromCriteriaTool, {
        criteria: {
          artist: "Brian Eno",
          limit: 25,
          sortBy: "playCount",
          yearMax: 1980,
          yearMin: 1970,
        },
        name: "Curated Set",
      }),
      dryRunCase(updateTrackTool, {
        disliked: true,
        trackId: "AAAABBBBCCCCDDDD",
      }),
    ];

    for (const { payload, outputSchema } of cases) {
      expect(outputSchema.safeParse(payload).success).toBe(true);
    }
  });
});

/** A write tool with the default call-wide lock that runs only when `release` is called. */
const gatedWriteTool = (events: string[]) => {
  const gate = Promise.withResolvers<undefined>();
  const started = Promise.withResolvers<undefined>();
  const tool = defineTool({
    annotations: ADDITIVE_ANNOTATIONS,
    description: "Write after the test releases the gate.",
    dryRunResult: () => ({ ok: false }),
    async handler() {
      events.push("other write start");
      started.resolve();
      await gate.promise;
      events.push("other write end");
      return { structuredContent: { ok: true } };
    },
    inputSchema: z.object({}),
    name: "test.write",
    outputSchema: z.object({ ok: z.boolean() }),
    writesRequired: true,
  });
  return {
    release: () => {
      gate.resolve();
    },
    started: started.promise,
    tool,
  };
};

describe("mutation lock scope", () => {
  const PLAYLIST_ID = "ABCDEF1234567890";
  const TRACK_ID = "AAAABBBBCCCCDDDD";
  const CRITERIA_ARGS = { criteria: { artist: "Brian Eno" }, name: "Eno" };

  const criteriaTool = (
    events: string[],
    scanGate: Promise<unknown> = Promise.resolve()
  ) => {
    const scanStarted = Promise.withResolvers<undefined>();
    const tool = createCriteriaPlaylistTool({
      async addTracksToPlaylist(playlistId, trackIds) {
        events.push("add");
        return await Promise.resolve({
          added: trackIds.length,
          addedTrackIds: trackIds,
          failedTrackIds: [],
          missingTrackIds: [],
          playlistId,
          requested: trackIds.length,
        });
      },
      async createPlaylist({ name }) {
        events.push("create");
        return await Promise.resolve({
          id: PLAYLIST_ID,
          isSmart: false,
          name,
          trackCount: 0,
        });
      },
      async findTracks() {
        events.push("scan start");
        scanStarted.resolve();
        await scanGate;
        events.push("scan end");
        return {
          limit: 1,
          scanned: 1,
          totalMatched: 1,
          tracks: [
            {
              album: "Apollo",
              artist: "Brian Eno",
              duration: 266,
              genre: "Ambient",
              id: TRACK_ID,
              name: "An Ending",
              playCount: 3,
              year: 1983,
            },
          ],
          truncated: false,
        };
      },
    });
    return { scanStarted: scanStarted.promise, tool };
  };

  test("another write runs while create_playlist_from_criteria is still scanning", async () => {
    const events: string[] = [];
    const scanGate = Promise.withResolvers<undefined>();
    const criteria = criteriaTool(events, scanGate.promise);
    const other = gatedWriteTool(events);
    other.release();

    await withClient(
      "2025-era",
      async (client) => {
        const pending = client.callTool({
          arguments: CRITERIA_ARGS,
          name: "music.create_playlist_from_criteria",
        });
        await criteria.scanStarted;

        const write = await client.callTool({
          arguments: {},
          name: "test.write",
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
          addedTrackIds: [TRACK_ID],
          playlist: { id: PLAYLIST_ID, name: "Eno", trackCount: 1 },
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
        const write = client.callTool({ arguments: {}, name: "test.write" });
        await other.started;
        const created = client.callTool({
          arguments: CRITERIA_ARGS,
          name: "music.create_playlist_from_criteria",
        });
        await criteria.scanStarted;
        await sleep(20);
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

  const deleteServer = (
    kind: "user" | "folder" = "user",
    config: RuntimeConfig = WRITES_ENABLED
  ) => {
    const deletedIds: string[] = [];
    const operations = createPlaylistEditOperations(async (script) => {
      const deleting = script.includes("delete p");
      if (deleting) {
        deletedIds.push(PLAYLIST_ID);
      }
      return await Promise.resolve({
        stderr: "",
        stdout: JSON.stringify({
          applied: deleting,
          folderId: "",
          found: true,
          id: PLAYLIST_ID,
          isSmart: false,
          kind,
          name: "Road Trip",
          trackCount: 12,
        }),
      });
    });
    return {
      deletedIds,
      server: { config, tools: [createDeletePlaylistTool(operations)] },
    };
  };

  const callDelete = async (client: Client, args: { confirm?: boolean } = {}) =>
    await client.callTool({
      arguments: { playlistId: PLAYLIST_ID, ...args },
      name: "music.delete_playlist",
    });

  const errorPayload = (response: Awaited<ReturnType<typeof callDelete>>) => {
    expect(response.isError).toBe(true);
    const [content] = response.content;
    if (!content || content.type !== "text") {
      throw new Error("Expected text error content.");
    }
    return ErrorPayloadSchema.parse(JSON.parse(content.text));
  };

  for (const era of ERAS) {
    test(`${era} client with elicitation deletes only after the user accepts`, async () => {
      const { deletedIds, server } = deleteServer();
      const prompts: string[] = [];
      // confirm: true must not skip the prompt when the client can show one.
      const accepted = await withClient(
        era,
        async (client) => await callDelete(client, { confirm: true }),
        {
          elicit: (params) => {
            prompts.push(params.message);
            return { action: "accept", content: { confirm: true } };
          },
          server,
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
      await Promise.all(
        answers.map(async (answer) => {
          const { deletedIds, server } = deleteServer();
          const response = await withClient(
            era,
            async (client) => await callDelete(client),
            {
              elicit: () => answer,
              server,
            }
          );
          expect(errorPayload(response)).toEqual({
            code: "validation_error",
            message: "Deletion cancelled. Nothing was deleted.",
          });
          expect(deletedIds).toEqual([]);
        })
      );
    });

    test(`${era} client without elicitation must pass confirm: true`, async () => {
      const unconfirmed = deleteServer();
      const refused = await withClient(
        era,
        async (client) => await callDelete(client),
        {
          server: unconfirmed.server,
        }
      );
      const error = errorPayload(refused);
      expect(error.code).toBe("validation_error");
      expect(error.message).toContain("confirm: true");
      expect(unconfirmed.deletedIds).toEqual([]);

      const confirmed = deleteServer();
      const deleted = await withClient(
        era,
        async (client) => await callDelete(client, { confirm: true }),
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
      async (client) => await callDelete(client, { confirm: true }),
      {
        elicit: (params) => {
          prompts.push(params.message);
          return { action: "accept", content: { confirm: true } };
        },
        server,
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
      dryRun: true,
      writesEnabled: true,
    });
    const prompts: string[] = [];
    const response = await withClient(
      "2025-era",
      async (client) => await callDelete(client),
      {
        elicit: (params) => {
          prompts.push(params.message);
          return { action: "accept", content: { confirm: true } };
        },
        server,
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

interface JsonSchemaNode {
  description?: string | undefined;
  properties?: Record<string, JsonSchemaNode> | undefined;
  items?: JsonSchemaNode | undefined;
  anyOf?: JsonSchemaNode[] | undefined;
  oneOf?: JsonSchemaNode[] | undefined;
  allOf?: JsonSchemaNode[] | undefined;
}

const JsonSchemaNodeSchema: z.ZodType<JsonSchemaNode> = z.lazy(() =>
  z.object({
    allOf: z.array(JsonSchemaNodeSchema).optional(),
    anyOf: z.array(JsonSchemaNodeSchema).optional(),
    description: z.string().optional(),
    items: JsonSchemaNodeSchema.optional(),
    oneOf: z.array(JsonSchemaNodeSchema).optional(),
    properties: z.record(z.string(), JsonSchemaNodeSchema).optional(),
  })
);

const undescribedProperties = (
  schema: JsonSchemaNode,
  path: string
): string[] => {
  const nested = [
    ...Object.entries(schema.properties ?? {}).flatMap(([name, property]) => [
      ...((property.description?.trim() ?? "") === ""
        ? [`${path}.${name}`]
        : []),
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
};

// Code-mode clients such as OpenCode show only the first line of a tool description, cut at
// 120 characters, and turn property descriptions into the JSDoc of generated signatures.
describe("tool metadata for code-mode clients", () => {
  test("every input property at every depth has a description", async () => {
    await withClient("2025-era", async (client) => {
      const { tools } = await client.listTools();
      const missing = tools.flatMap((tool) =>
        undescribedProperties(
          JsonSchemaNodeSchema.parse(tool.inputSchema),
          tool.name
        )
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
