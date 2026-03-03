import * as z from "zod/v4";
import { SERVER_NAME, SERVER_VERSION, runtimeConfig } from "../config.js";
import type { ToolDef } from "../server.js";

export const capabilitiesTool: ToolDef = {
    name: "music.capabilities",
    description: "Report server capabilities and runtime flags.",
    inputSchema: {},
    outputSchema: {
        serverName: z.string(),
        serverVersion: z.string(),
        writesEnabled: z.boolean(),
        dryRun: z.boolean(),
        tools: z.array(z.string()),
    },
    writesRequired: false,
    async handler() {
        const capabilities = {
            serverName: SERVER_NAME,
            serverVersion: SERVER_VERSION,
            writesEnabled: runtimeConfig.writesEnabled,
            dryRun: runtimeConfig.dryRun,
            tools: [
                "music.capabilities",
                "music.health",
                "music.list_folders",
                "music.list_playlists",
                "music.create_playlist",
                "music.create_folder",
                "music.move_playlist",
                "music.get_now_playing",
                "music.playback_control",
                "music.search_library",
                "music.get_playlist_tracks",
                "music.add_tracks_to_playlist",
            ],
        };
        return { structuredContent: capabilities };
    },
};
