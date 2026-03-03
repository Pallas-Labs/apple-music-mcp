import { describe, expect, test } from "bun:test";
import * as z from "zod/v4";
import { createServer } from "./server.js";
import {
    addTracksToPlaylistTool,
    createFolderTool,
    createPlaylistTool,
    movePlaylistTool,
    playbackControlTool,
} from "./tools/index.js";

describe("createServer", () => {
    test("creates a server instance", () => {
        const server = createServer();
        expect(server).toBeDefined();
    });

    test("write tools provide dry-run payloads matching output schema", () => {
        const cases = [
            {
                tool: createPlaylistTool,
                input: { name: "Dry Run Playlist", folderId: "ABCDEF1234567890" },
            },
            {
                tool: createFolderTool,
                input: { name: "Dry Run Folder", parentId: "ABCDEF1234567890" },
            },
            {
                tool: movePlaylistTool,
                input: { playlistId: "ABCDEF1234567890", targetFolderId: "12345678ABCDEFGH" },
            },
            {
                tool: playbackControlTool,
                input: { action: "play" as const },
            },
            {
                tool: addTracksToPlaylistTool,
                input: {
                    playlistId: "ABCDEF1234567890",
                    trackIds: ["1111222233334444", "AAAABBBBCCCCDDDD"],
                },
            },
        ];

        for (const item of cases) {
            expect(item.tool.dryRunResult).toBeDefined();
            const dryRunPayload = item.tool.dryRunResult!(item.input);
            const parseResult = z.object(item.tool.outputSchema).safeParse(dryRunPayload);
            expect(parseResult.success).toBe(true);
        }
    });
});
