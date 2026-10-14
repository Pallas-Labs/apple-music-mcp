import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";

import { createServer } from "./server.js";

const HOST = "127.0.0.1";
const ENDPOINT = "/mcp";

/**
 * Serve MCP over Streamable HTTP on 127.0.0.1. The Host check blocks DNS rebinding, and requests
 * that carry an Origin header are refused because only local clients, not web pages, may connect.
 */
export function serveHttp(port: number): { close: () => Promise<void> } {
  const handler = createMcpHandler(() => createServer());
  const allowedHosts = localhostAllowedHostnames();

  const server = createHttpServer(async (req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      abort.abort();
    });
    const request = toRequest(req, abort.signal);
    const response =
      new URL(request.url).pathname === ENDPOINT
        ? request.headers.has("origin")
          ? new Response("Browser requests are not allowed", { status: 403 })
          : (hostHeaderValidationResponse(request, allowedHosts) ??
            (await handler.fetch(request)))
        : new Response("Not found", { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      await pipeline(
        Readable.fromWeb(response.body as NodeReadableStream),
        res
      ).catch(() => {});
    } else {
      res.end();
    }
  });
  server.listen(port, HOST);

  return {
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await handler.close();
    },
  };
}

function toRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, values] of Object.entries(req.headersDistinct)) {
    for (const value of values ?? []) {
      headers.append(name, value);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(`http://${req.headers.host ?? HOST}${req.url ?? "/"}`, {
    headers,
    method: req.method ?? "GET",
    signal,
    ...(hasBody
      ? { body: Readable.toWeb(req) as ReadableStream, duplex: "half" }
      : {}),
  });
}
