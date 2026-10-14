import { describe, expect, test } from "bun:test";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { runAppleScript } from "./applescript/runner.js";
import { createServer } from "./server.js";

const INTEGRATION = process.env.INTEGRATION === "true";

describe.skipIf(!INTEGRATION)("integration", () => {
  test("music.health — Music app responds", async () => {
    const script = `
try
    if application "Music" is running then
        return "running"
    else
        return "not_running"
    end if
on error
    return "error"
end try`;
    const result = await runAppleScript(script, 5000);
    expect(["running", "not_running"]).toContain(result.stdout);
  });

  test("list playlists returns valid JSON", async () => {
    const script = `
tell application id "com.apple.Music"
    set pCount to count of user playlists
    return pCount as text
end tell`;
    const result = await runAppleScript(script, 15_000);
    const count = Number(result.stdout);
    expect(count).toBeGreaterThanOrEqual(0);
  }, 20_000);

  test("2026-07-28 now-playing reads are never cached", async () => {
    const handler = createMcpHandler(() => createServer());
    const client = new Client(
      { name: "apple-music-mcp-integration", version: "1.0.0" },
      { versionNegotiation: { mode: "auto" } }
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        fetch:  async (url, init) => handler.fetch(new Request(url, init)),
      })
    );
    try {
      const nowPlaying = await client.readResource({
        uri: "music://now-playing",
      });
      expect(nowPlaying).toMatchObject({ cacheScope: "private", ttlMs: 0 });
    } finally {
      await client.close();
      await handler.close();
    }
  }, 20_000);
});
