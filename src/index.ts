#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { serveHttp } from "./http.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";

const httpPort = process.env["APPLE_MUSIC_MCP_HTTP_PORT"]?.trim();
if (httpPort && !/^\d{1,5}$/.test(httpPort)) {
  log("server_fatal", {
    message: `APPLE_MUSIC_MCP_HTTP_PORT must be a port number, got "${httpPort}".`,
  });
  process.exit(1);
}
const handle = httpPort ? serveHttp(Number(httpPort)) : serveStdio(() => createServer());
log("server_started", {
  name: SERVER_NAME,
  version: SERVER_VERSION,
  transport: httpPort ? `http://127.0.0.1:${httpPort}/mcp` : "stdio",
});

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  log("server_shutdown", { name: SERVER_NAME });
  void handle.close().then(
    () => process.exit(0),
    (error: unknown) => {
      log("server_fatal", { message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    },
  );
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
