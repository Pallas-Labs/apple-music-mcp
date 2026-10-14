import { afterAll, describe, expect, test } from "bun:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

import { serveHttp } from "./http.js";

const port = 40_000 + Math.floor(Math.random() * 20_000);
const url = new URL(`http://127.0.0.1:${port}/mcp`);
const server = serveHttp(port);
afterAll(async () => {
  await server.close();
});

const post = async (headers: Record<string, string>): Promise<Response> =>
  await fetch(url, {
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "ping" }),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });

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
    const browser = await post({ origin: "https://example.com" });
    expect(browser.status).toBe(403);
    const foreignHost = await post({ host: `example.com:${port}` });
    expect(foreignHost.status).toBe(403);
  });

  test("serves only the /mcp path", async () => {
    const response = await fetch(new URL("/other", url));
    expect(response.status).toBe(404);
  });
});
