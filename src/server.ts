import {
  CLIENT_CAPABILITIES_META_KEY,
  isInputRequiredResult,
  McpServer,
  specTypeSchemas,
} from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  ClientCapabilities,
  ServerContext,
  TextContent,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { SERVER_NAME, SERVER_VERSION, runtimeConfig } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { log } from "./logger.js";
import {
  registerPrompts,
  registerResources,
  STATIC_CATALOGUE_CACHE_HINT,
} from "./mcp-features.js";
import { withMutationLock } from "./mutation-lock.js";
import type {
  AnyToolDef,
  ToolContext,
  ToolDef,
  ToolSchema,
} from "./tool-contracts.js";
import { allTools } from "./tools/index.js";
import { MusicToolError } from "./types.js";

export { defineTool } from "./tool-contracts.js";
export type { ToolContext, ToolDef, ToolResult } from "./tool-contracts.js";

// The largest valid input is 100 track IDs, so 512 leaves headroom and rejects floods early.
const MAX_TOOL_INPUT_ELEMENTS = 512;

/** Accepts any non-array object, which is what structuredContent must be. */
const StructuredContentSchema = z.looseObject({});

const toolTitle = (name: string): string =>
  name
    .replace(/^music\./u, "")
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

interface ToolErrorResult extends CallToolResult {
  content: [TextContent];
  isError: true;
}

export const toolErrorResult = (error?: Error): ToolErrorResult => {
  const payload =
    error instanceof MusicToolError
      ? { code: error.code, message: error.message }
      : {
          code: "script_error",
          message: "An unexpected server error occurred.",
        };

  return {
    content: [{ text: JSON.stringify(payload), type: "text" }],
    isError: true,
  };
};

const clientCapabilities = (
  server: McpServer,
  ctx: ServerContext
): ClientCapabilities | undefined => {
  // 2026-07-28 requests carry capabilities in their envelope; 2025-era clients declared them at
  // initialize, which only the server instance remembers.
  const { envelope } = ctx.mcpReq;
  if (envelope !== undefined && CLIENT_CAPABILITIES_META_KEY in envelope) {
    const declared = specTypeSchemas.ClientCapabilities["~standard"].validate(
      envelope[CLIENT_CAPABILITIES_META_KEY]
    );
    if (declared.issues === undefined) {
      return declared.value;
    }
  }
  // oxlint-disable-next-line typescript/no-deprecated -- The SDK's documented source for 2025-era clients.
  return server.server.getClientCapabilities();
};

/** The parts of ToolContext fixed when the server is created. */
type ServerInfo = Pick<ToolContext, "config" | "toolNames">;

const toolContext = (
  server: McpServer,
  ctx: ServerContext,
  serverInfo: ServerInfo
): ToolContext => {
  const elicitation = clientCapabilities(server, ctx)?.elicitation;
  return {
    ...serverInfo,
    // An elicitation capability with neither mode listed means form mode.
    canElicit:
      elicitation !== undefined &&
      (elicitation.form !== undefined || elicitation.url === undefined),
    inputResponses: ctx.mcpReq.inputResponses,
  };
};

const registerTool = <Input extends ToolSchema, Output extends ToolSchema>(
  server: McpServer,
  tool: ToolDef<Input, Output>,
  serverInfo: ServerInfo
): void => {
  const { config } = serverInfo;
  server.registerTool<ToolSchema, ToolSchema>(
    tool.name,
    {
      annotations: tool.annotations,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      title: toolTitle(tool.name),
    },
    async (args, ctx) => {
      const startedAt = Date.now();
      try {
        // Write gate
        if (tool.writesRequired && !config.writesEnabled) {
          return toolErrorResult(
            new MusicToolError(
              "validation_error",
              "Writes are disabled. Set APPLE_MUSIC_MCP_ENABLE_WRITES=true to enable mutation tools."
            )
          );
        }

        // The SDK has already validated `args` with this schema; parsing again recovers its type.
        const parsed = await tool.inputSchema["~standard"].validate(args);
        if (parsed.issues !== undefined) {
          throw new MusicToolError(
            "validation_error",
            "Invalid tool arguments."
          );
        }
        const input = parsed.value;

        // Dry run
        if (tool.writesRequired && config.dryRun) {
          const structuredContent = tool.dryRunResult(input);
          if (!StructuredContentSchema.safeParse(structuredContent).success) {
            throw new MusicToolError(
              "script_error",
              "Tool returned a non-object dry-run result."
            );
          }
          return {
            content: [
              {
                text: JSON.stringify({
                  dryRun: true,
                  input,
                  response: structuredContent,
                  tool: tool.name,
                }),
                type: "text" as const,
              },
            ],
            structuredContent,
          };
        }

        // Each round of a multi-round call takes the lock separately, so no lock is held while the
        // client waits on the user.
        const context = toolContext(server, ctx, serverInfo);
        const execute = async () => await tool.handler(input, context);
        const lockCall = tool.writesRequired && tool.lock !== "handler";
        const result = lockCall
          ? await withMutationLock(execute)
          : await execute();
        if (isInputRequiredResult(result)) {
          log("tool_input_required", {
            durationMs: Date.now() - startedAt,
            inputRequests: Object.keys(result.inputRequests ?? {}),
            tool: tool.name,
          });
          return result;
        }
        const { structuredContent } = result;
        if (!StructuredContentSchema.safeParse(structuredContent).success) {
          throw new MusicToolError(
            "script_error",
            "Tool returned a non-object structured result."
          );
        }

        log("tool_success", {
          durationMs: Date.now() - startedAt,
          tool: tool.name,
          ...result.logData,
        });

        return {
          content: [
            { text: JSON.stringify(structuredContent), type: "text" as const },
          ],
          structuredContent,
        };
      } catch (error) {
        const failure = error instanceof Error ? error : undefined;
        log("tool_error", {
          durationMs: Date.now() - startedAt,
          message: failure?.message ?? String(error),
          tool: tool.name,
        });
        return toolErrorResult(failure);
      }
    }
  );
};

export interface CreateServerOptions {
  config?: RuntimeConfig;
  tools?: readonly AnyToolDef[];
}

export const createServer = ({
  config = runtimeConfig,
  tools = allTools,
}: CreateServerOptions = {}): McpServer => {
  const server = new McpServer(
    {
      description:
        "Read/write access to Apple Music playlists, folders, tracks, and playback on macOS. Mutations are non-atomic via AppleScript — partial failures are possible for bulk operations.",
      name: SERVER_NAME,
      title: "Apple Music MCP",
      version: SERVER_VERSION,
      websiteUrl: "https://github.com/Pallas-Labs/apple-music-mcp",
    },
    {
      cacheHints: {
        "prompts/list": STATIC_CATALOGUE_CACHE_HINT,
        "resources/list": STATIC_CATALOGUE_CACHE_HINT,
        "resources/templates/list": STATIC_CATALOGUE_CACHE_HINT,
        "server/discover": STATIC_CATALOGUE_CACHE_HINT,
        "tools/list": STATIC_CATALOGUE_CACHE_HINT,
      },
      capabilities: {
        prompts: {},
        resources: {},
        tools: {},
      },
      instructions:
        "Call music.health first. Read tools never change Music. Write tools need APPLE_MUSIC_MCP_ENABLE_WRITES=true. Each result is structuredContent that matches the tool's outputSchema. Errors set isError; server errors carry JSON text {code,message}. Pass persistent IDs from read results to later tools. If your client runs tools from code, chain read calls in one script. Bulk writes are not atomic, so check the returned ID lists. See music://guide.",
      maxToolInputElements: MAX_TOOL_INPUT_ELEMENTS,
    }
  );

  const serverInfo: ServerInfo = {
    config,
    toolNames: tools.map((tool) => tool.name),
  };
  for (const tool of tools) {
    tool.withTypes((typedTool) => {
      registerTool(server, typedTool, serverInfo);
    });
  }
  registerResources(server);
  registerPrompts(server);

  return server;
};
