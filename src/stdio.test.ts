import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

import { Client } from '@modelcontextprotocol/client';
import type { ClientOptions, ProtocolEra } from '@modelcontextprotocol/client';
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { allTools } from "./tools/index.js";

const ENTRYPOINT = fileURLToPath(new URL("index.ts", import.meta.url));

// Mirrors OpenCode's per-server `protocol` option: "legacy", "auto", and "2026-07-28".
const PROTOCOL_CONFIGS: {
  protocol: string;
  options: ClientOptions;
  era: ProtocolEra;
}[] = [
  { era: "legacy", options: {}, protocol: "legacy" },
  {
    era: "modern",
    options: { versionNegotiation: { mode: "auto" } },
    protocol: "auto",
  },
  {
    era: "modern",
    options: { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    protocol: "2026-07-28",
  },
];

describe("stdio entrypoint", () => {
  for (const { protocol, options, era } of PROTOCOL_CONFIGS) {
    test(`negotiates the ${era} era for protocol "${protocol}"`, async () => {
      const transport = new StdioClientTransport({
        args: [ENTRYPOINT],
        command: process.execPath,
        stderr: "ignore",
      });
      const client = new Client(
        { name: "apple-music-mcp-stdio-test", version: "1.0.0" },
        options
      );
      try {
        const startedAt = performance.now();
        await client.connect(transport);
        const connectMs = performance.now() - startedAt;
        expect(client.getProtocolEra()).toBe(era);
        expect(connectMs).toBeLessThan(5000);

        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toEqual(
          allTools.map((tool) => tool.name)
        );
      } finally {
        await client.close();
      }
    }, 15_000);
  }
});
