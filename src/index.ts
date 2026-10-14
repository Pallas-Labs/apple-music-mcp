#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { serveHttp } from "./http.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";

const httpPort = process.env.APPLE_MUSIC_MCP_HTTP_PORT?.trim() ?? "";
const useHttp = httpPort !== "";
if (useHttp && !/^\d{1,5}$/u.test(httpPort)) {
  log("server_fatal", {
    message: `APPLE_MUSIC_MCP_HTTP_PORT must be a port number, got "${httpPort}".`,
  });
  process.exit(1);
}
const handle = useHttp
  ? serveHttp(Number(httpPort))
  : serveStdio(() => createServer());
log("server_started", {
  name: SERVER_NAME,
  transport: useHttp ? `http://127.0.0.1:${httpPort}/mcp` : "stdio",
  version: SERVER_VERSION,
});

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("server_shutdown", { name: SERVER_NAME });
  setTimeout(() => process.exit(1), 5000).unref();
  try {
    await handle.close();
    process.exit(0);
  } catch (error) {
    log("server_fatal", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
};

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});
