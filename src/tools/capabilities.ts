import * as z from "zod/v4";
import { SERVER_NAME, SERVER_VERSION, runtimeConfig } from "../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "../tool-contracts.js";
// Circular import: `allTools` is read only when the handler runs, after both modules load.
import { allTools } from "./index.js";

const capabilitiesInputSchema = z.object({});
const capabilitiesOutputSchema = z.object({
  serverName: z.string(),
  serverVersion: z.string(),
  writesEnabled: z.boolean().describe("True when mutation tools may change Apple Music."),
  dryRun: z.boolean().describe("True when mutation tools return previews without changing Music."),
  tools: z.array(z.string()).describe("Names of every tool this server provides."),
});

export const capabilitiesTool = defineTool({
  name: "music.capabilities",
  description: "Report the server version, write and dry-run flags, and the names of all tools.",
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
      tools: allTools.map((tool) => tool.name),
    };
    return { structuredContent: capabilities };
  },
});
