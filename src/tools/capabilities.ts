import * as z from "zod/v4";
import { SERVER_NAME, SERVER_VERSION, runtimeConfig } from "../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "../tool-contracts.js";

const capabilitiesInputSchema = {};
const capabilitiesOutputSchema = {
  serverName: z.string(),
  serverVersion: z.string(),
  writesEnabled: z.boolean(),
  dryRun: z.boolean(),
  tools: z.array(z.string()),
};

export const capabilitiesTool = defineTool({
  name: "music.capabilities",
  description: "Report server capabilities and runtime flags.",
  inputSchema: capabilitiesInputSchema,
  outputSchema: capabilitiesOutputSchema,
  annotations: READ_ONLY_ANNOTATIONS,
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
        "music.create_playlist_from_criteria",
        "music.create_folder",
        "music.move_playlist",
        "music.get_now_playing",
        "music.playback_control",
        "music.search_library",
        "music.find_tracks",
        "music.get_playlist_tracks",
        "music.add_tracks_to_playlist",
        "music.remove_tracks_from_playlist",
      ],
    };
    return { structuredContent: capabilities };
  },
});
