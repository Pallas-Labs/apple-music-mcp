import { afterAll, describe, expect, test } from "bun:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { serveHttp } from "./http.js";

const port = 40_000 + Math.floor(Math.random() * 20_000);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const server = serveHttp(port);
afterAll(async () => server.close());

async function post(headers: Record<string, string>): Promise<Response> {
  return fetch(url, {
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
}

describe("HTTP transport", () => {
  for (const mode of ["legacy", "auto"] as const) {
    test(`lists tools with ${mode} protocol negotiation`, async () => {
      const client = new Client(
        { name: "http-test", version: "1.0.0" },
        { versionNegotiation: { mode } }
      );
      await client.connect(new StreamableHTTPClientTransport(url));
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name)).toContain("music.find_tracks");
      } finally {
        await client.close();
      }
    });
  }

  test("refuses browser requests and foreign Host headers", async () => {
    expect((await post({ origin: "https://example.com" })).status).toBe(403);
    expect((await post({ host: `example.com:${port}` })).status).toBe(403);
  });

  test("serves only the /mcp path", async () => {
    expect((await fetch(new URL("/other", url))).status).toBe(404);
  });
});
