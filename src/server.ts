import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolDef, ToolSchema, ToolSchemaOutput } from "./tool-contracts.js";
export { defineTool } from "./tool-contracts.js";
export type { ToolDef, ToolResult } from "./tool-contracts.js";
import { SERVER_NAME, SERVER_VERSION, runtimeConfig } from "./config.js";
import { MusicToolError } from "./types.js";
import { log } from "./logger.js";
import {
  capabilitiesTool,
  healthTool,
  listFoldersTool,
  listPlaylistsTool,
  createPlaylistTool,
  createPlaylistFromCriteriaTool,
  createFolderTool,
  movePlaylistTool,
  getNowPlayingTool,
  playbackControlTool,
  searchLibraryTool,
  findTracksTool,
  getPlaylistTracksTool,
  addTracksToPlaylistTool,
  removeTracksFromPlaylistTool,
} from "./tools/index.js";

let mutationQueue: Promise<void> = Promise.resolve();

function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(operation, operation);
  mutationQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolErrorResult(error: unknown): {
  isError: true;
  content: [{ type: "text"; text: string }];
} {
  const payload =
    error instanceof MusicToolError
      ? { code: error.code, message: error.message }
      : { code: "script_error", message: "An unexpected server error occurred." };

  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function registerAllTools(server: McpServer): void {
  registerTool(server, capabilitiesTool);
  registerTool(server, healthTool);
  registerTool(server, listFoldersTool);
  registerTool(server, listPlaylistsTool);
  registerTool(server, createPlaylistTool);
  registerTool(server, createPlaylistFromCriteriaTool);
  registerTool(server, createFolderTool);
  registerTool(server, movePlaylistTool);
  registerTool(server, getNowPlayingTool);
  registerTool(server, playbackControlTool);
  registerTool(server, searchLibraryTool);
  registerTool(server, findTracksTool);
  registerTool(server, getPlaylistTracksTool);
  registerTool(server, addTracksToPlaylistTool);
  registerTool(server, removeTracksFromPlaylistTool);
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: "Apple Music MCP",
      version: SERVER_VERSION,
      description:
        "Read/write access to Apple Music playlists, folders, tracks, and playback on macOS. Mutations are non-atomic via AppleScript — partial failures are possible for bulk operations.",
    },
    {
      instructions:
        "Use music.health first. Read tools are always safe. Mutation tools require APPLE_MUSIC_MCP_ENABLE_WRITES=true. IDs are persistent IDs from Apple Music.",
    },
  );

  registerAllTools(server);

  return server;
}

function registerTool<Input extends ToolSchema, Output extends ToolSchema>(
  server: McpServer,
  tool: ToolDef<Input, Output>,
): void {
  server.registerTool<Output, Input>(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    (async (input: ToolSchemaOutput<Input>) => {
      const startedAt = Date.now();
      try {
        // Write gate
        if (tool.writesRequired && !runtimeConfig.writesEnabled) {
          return toolErrorResult(
            new MusicToolError(
              "validation_error",
              "Writes are disabled. Set APPLE_MUSIC_MCP_ENABLE_WRITES=true to enable mutation tools.",
            ),
          );
        }

        // Dry run
        if (tool.writesRequired && runtimeConfig.dryRun) {
          const structuredContent = tool.dryRunResult(input);
          if (!isRecord(structuredContent)) {
            throw new MusicToolError("script_error", "Tool returned a non-object dry-run result.");
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  dryRun: true,
                  tool: tool.name,
                  input,
                  response: structuredContent,
                }),
              },
            ],
            structuredContent,
          };
        }

        // Execute (with mutation lock for writes)
        const execute = () => tool.handler(input);
        const result = tool.writesRequired ? await withMutationLock(execute) : await execute();
        const structuredContent = result.structuredContent;
        if (!isRecord(structuredContent)) {
          throw new MusicToolError("script_error", "Tool returned a non-object structured result.");
        }

        log("tool_success", {
          tool: tool.name,
          durationMs: Date.now() - startedAt,
          ...result.logData,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
          structuredContent,
        };
      } catch (error) {
        log("tool_error", {
          tool: tool.name,
          durationMs: Date.now() - startedAt,
          message: error instanceof Error ? error.message : String(error),
        });
        return toolErrorResult(error);
      }
    }) as unknown as ToolCallback<Input>,
  );
}
