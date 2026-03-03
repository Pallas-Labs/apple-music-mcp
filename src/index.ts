#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SERVER_NAME, SERVER_VERSION } from "./config.js";
import { log } from "./logger.js";
import { createServer } from "./server.js";

const server = createServer();

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("server_started", { name: SERVER_NAME, version: SERVER_VERSION });
}

// Graceful shutdown
function shutdown(): void {
    log("server_shutdown", { name: SERVER_NAME });
    server.close().then(
        () => process.exit(0),
        () => process.exit(1),
    );
    // Force exit after 5s if close hangs
    setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error: unknown) => {
    log("server_fatal", { message: error instanceof Error ? error.message : String(error) });
    process.exit(1);
});
