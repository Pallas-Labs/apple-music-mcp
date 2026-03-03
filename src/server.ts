import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { SERVER_NAME, SERVER_VERSION, runtimeConfig } from "./config.js";
import { MusicToolError } from "./types.js";
import { log } from "./logger.js";
import {
    capabilitiesTool,
    healthTool,
    listFoldersTool,
    listPlaylistsTool,
    createPlaylistTool,
    createFolderTool,
    movePlaylistTool,
    getNowPlayingTool,
    playbackControlTool,
    searchLibraryTool,
    getPlaylistTracksTool,
    addTracksToPlaylistTool,
} from "./tools/index.js";

export type ToolResult = {
    structuredContent: Record<string, unknown>;
    logData?: Record<string, unknown>;
};

export type ToolDef = {
    name: string;
    description: string;
    inputSchema: ZodRawShapeCompat;
    outputSchema: ZodRawShapeCompat;
    writesRequired: boolean;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dryRunResult?: (input: any) => Record<string, unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (input: any) => Promise<ToolResult>;
};

let mutationQueue: Promise<void> = Promise.resolve();

function withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = mutationQueue.then(operation, operation);
    mutationQueue = next.then(
        () => undefined,
        () => undefined,
    );
    return next;
}

function toolErrorResult(error: unknown): { isError: true; content: [{ type: "text"; text: string }] } {
    if (error instanceof MusicToolError) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: JSON.stringify({ code: error.code, message: error.message, details: error.details }),
                },
            ],
        };
    }
    return {
        isError: true,
        content: [
            {
                type: "text",
                text: JSON.stringify({
                    code: "script_error",
                    message: error instanceof Error ? error.message : "Unknown server error",
                }),
            },
        ],
    };
}

const allTools: ToolDef[] = [
    capabilitiesTool,
    healthTool,
    listFoldersTool,
    listPlaylistsTool,
    createPlaylistTool,
    createFolderTool,
    movePlaylistTool,
    getNowPlayingTool,
    playbackControlTool,
    searchLibraryTool,
    getPlaylistTracksTool,
    addTracksToPlaylistTool,
];

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

    for (const tool of allTools) {
        registerTool(server, tool);
    }

    return server;
}

function registerTool(server: McpServer, tool: ToolDef): void {
    const hasInput = Object.keys(tool.inputSchema).length > 0;

    server.registerTool(
        tool.name,
        {
            description: tool.description,
            ...(hasInput ? { inputSchema: tool.inputSchema } : {}),
            outputSchema: tool.outputSchema,
        },
        async (input: any) => {
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
                    const structuredContent = tool.dryRunResult
                        ? tool.dryRunResult(input)
                        : { dryRun: true, tool: tool.name, input };
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: JSON.stringify({ dryRun: true, tool: tool.name, input, response: structuredContent }),
                            },
                        ],
                        structuredContent,
                    };
                }

                // Execute (with mutation lock for writes)
                const execute = () => tool.handler(input);
                const result = tool.writesRequired ? await withMutationLock(execute) : await execute();

                log("tool_success", {
                    tool: tool.name,
                    durationMs: Date.now() - startedAt,
                    ...result.logData,
                });

                return {
                    content: [{ type: "text" as const, text: JSON.stringify(result.structuredContent) }],
                    structuredContent: result.structuredContent,
                };
            } catch (error) {
                log("tool_error", {
                    tool: tool.name,
                    durationMs: Date.now() - startedAt,
                    message: error instanceof Error ? error.message : String(error),
                });
                return toolErrorResult(error);
            }
        },
    );
}
