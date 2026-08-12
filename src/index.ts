#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";

const handle = serveStdio(createServer);
log("server_started", { name: SERVER_NAME, version: SERVER_VERSION });

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
