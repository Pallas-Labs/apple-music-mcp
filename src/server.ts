import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  McpServer,
} from "@modelcontextprotocol/server";
import type { ClientCapabilities, ServerContext, ToolCallback } from "@modelcontextprotocol/server";
import type { AnyToolDef, ToolContext, ToolSchema } from "./tool-contracts.js";
export { defineTool } from "./tool-contracts.js";
export type { ToolContext, ToolDef, ToolResult } from "./tool-contracts.js";
import { SERVER_NAME, SERVER_VERSION, runtimeConfig, type RuntimeConfig } from "./config.js";
import { MusicToolError } from "./types.js";
import { log } from "./logger.js";
import { withMutationLock } from "./mutation-lock.js";
import { registerPrompts, registerResources, STATIC_CATALOGUE_CACHE_HINT } from "./mcp-features.js";
import { allTools } from "./tools/index.js";

// The largest valid input is 100 track IDs, so 512 leaves headroom and rejects floods early.
const MAX_TOOL_INPUT_ELEMENTS = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolTitle(name: string): string {
  return name
    .replace(/^music\./, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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

export type CreateServerOptions = {
  config?: RuntimeConfig;
  tools?: readonly AnyToolDef[];
};

export function createServer({
  config = runtimeConfig,
  tools = allTools,
}: CreateServerOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: "Apple Music MCP",
      version: SERVER_VERSION,
      description:
        "Read/write access to Apple Music playlists, folders, tracks, and playback on macOS. Mutations are non-atomic via AppleScript — partial failures are possible for bulk operations.",
      websiteUrl: "https://github.com/Pallas-Labs/apple-music-mcp",
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      cacheHints: {
        "tools/list": STATIC_CATALOGUE_CACHE_HINT,
        "prompts/list": STATIC_CATALOGUE_CACHE_HINT,
        "resources/list": STATIC_CATALOGUE_CACHE_HINT,
        "resources/templates/list": STATIC_CATALOGUE_CACHE_HINT,
        "server/discover": STATIC_CATALOGUE_CACHE_HINT,
      },
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
      instructions:
        "Call music.health first. Read tools never change Music. Write tools need APPLE_MUSIC_MCP_ENABLE_WRITES=true. Each result is structuredContent that matches the tool's outputSchema. Errors set isError; server errors carry JSON text {code,message}. Pass persistent IDs from read results to later tools. If your client runs tools from code, chain read calls in one script. Bulk writes are not atomic, so check the returned ID lists. See music://guide.",
    },
  );

  const serverInfo: ServerInfo = { config, toolNames: tools.map((tool) => tool.name) };
  for (const tool of tools) registerTool(server, tool, serverInfo);
  registerResources(server);
  registerPrompts(server);

  return server;
}

function clientCapabilities(server: McpServer, ctx: ServerContext): ClientCapabilities | undefined {
  // 2026-07-28 requests carry capabilities in their envelope; 2025-era clients declared them at
  // initialize, which only the server instance remembers.
  const envelope = ctx.mcpReq.envelope as
    | Partial<Record<typeof CLIENT_CAPABILITIES_META_KEY, ClientCapabilities>>
    | undefined;
  return envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.server.getClientCapabilities();
}

/** The parts of ToolContext fixed when the server is created. */
type ServerInfo = Pick<ToolContext, "config" | "toolNames">;

function toolContext(server: McpServer, ctx: ServerContext, serverInfo: ServerInfo): ToolContext {
  const elicitation = clientCapabilities(server, ctx)?.elicitation;
  return {
    ...serverInfo,
    // An elicitation capability with neither mode listed means form mode.
    canElicit:
      elicitation !== undefined &&
      (elicitation.form !== undefined || elicitation.url === undefined),
    inputResponses: ctx.mcpReq.inputResponses,
  };
}

function registerTool(server: McpServer, tool: AnyToolDef, serverInfo: ServerInfo): void {
  const { config } = serverInfo;
  server.registerTool<ToolSchema, ToolSchema>(
    tool.name,
    {
      title: toolTitle(tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    },
    (async (input: never, ctx: ServerContext) => {
      const startedAt = Date.now();
      try {
        // Write gate
        if (tool.writesRequired && !config.writesEnabled) {
          return toolErrorResult(
            new MusicToolError(
              "validation_error",
              "Writes are disabled. Set APPLE_MUSIC_MCP_ENABLE_WRITES=true to enable mutation tools.",
            ),
          );
        }

        // Dry run
        if (tool.writesRequired && config.dryRun) {
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

        // Each round of a multi-round call takes the lock separately, so no lock is held while the
        // client waits on the user.
        const context = toolContext(server, ctx, serverInfo);
        const execute = () => tool.handler(input, context);
        const lockCall = tool.writesRequired && tool.lock !== "handler";
        const result = lockCall ? await withMutationLock(execute) : await execute();
        if (isInputRequiredResult(result)) {
          log("tool_input_required", {
            tool: tool.name,
            durationMs: Date.now() - startedAt,
            inputRequests: Object.keys(result.inputRequests ?? {}),
          });
          return result;
        }
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
    }) as unknown as ToolCallback<ToolSchema>,
  );
}
