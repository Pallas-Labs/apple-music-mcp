import * as z from "zod/v4";

import { SERVER_NAME, SERVER_VERSION } from "../config.js";
import { defineTool, READ_ONLY_ANNOTATIONS } from "../tool-contracts.js";

const capabilitiesInputSchema = z.object({});
const capabilitiesOutputSchema = z.object({
  dryRun: z
    .boolean()
    .describe(
      "True when mutation tools return previews without changing Music."
    ),
  serverName: z.string(),
  serverVersion: z.string(),
  tools: z
    .array(z.string())
    .describe("Names of every tool this server provides."),
  writesEnabled: z
    .boolean()
    .describe("True when mutation tools may change Apple Music."),
});

export const capabilitiesTool = defineTool({
  annotations: READ_ONLY_ANNOTATIONS,
  description:
    "Report the server version, write and dry-run flags, and the names of all tools.",
  async handler(_input, { config, toolNames }) {
    const capabilities = {
      serverName: SERVER_NAME,
      serverVersion: SERVER_VERSION,
      writesEnabled: config.writesEnabled,
      dryRun: config.dryRun,
      tools: [...toolNames],
    };
    return { structuredContent: capabilities };
  },
  inputSchema: capabilitiesInputSchema,
  name: "music.capabilities",
  outputSchema: capabilitiesOutputSchema,
  writesRequired: false,
});
