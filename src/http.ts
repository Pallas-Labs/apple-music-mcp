import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { arrayBuffer } from "node:stream/consumers";

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
} from "@modelcontextprotocol/server";

import { createServer } from "./server.js";

const HOST = "127.0.0.1";
const ENDPOINT = "/mcp";

export interface HttpServerHandle {
  close: () => Promise<void>;
}

const toRequest = async (
  req: IncomingMessage,
  url: string,
  signal: AbortSignal
): Promise<Request> => {
  // rawHeaders alternates names and values; Bun before 1.4 lacks headersDistinct.
  const headers = new Headers();
  for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
    headers.append(
      req.rawHeaders[index] ?? "",
      req.rawHeaders[index + 1] ?? ""
    );
  }
  const init: RequestInit = { headers, method: req.method ?? "GET", signal };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await arrayBuffer(req);
  }
  return new Request(url, init);
};

/** Copies a web response body to the Node response chunk by chunk, so SSE streams stay live. */
const writeBody = async (
  body: ReadableStream<Uint8Array>,
  res: ServerResponse
): Promise<void> => {
  try {
    for await (const chunk of body) {
      res.write(chunk);
    }
    res.end();
  } catch {
    // The client went away or the handler aborted the stream.
    res.destroy();
  }
};

/**
 * Serve MCP over Streamable HTTP on 127.0.0.1. The Host check blocks DNS rebinding, and requests
 * that carry an Origin header are refused because only local clients, not web pages, may connect.
 */
export const serveHttp = (port: number): HttpServerHandle => {
  const handler = createMcpHandler(() => createServer());
  const allowedHosts = localhostAllowedHostnames();

  const respond = async (
    req: IncomingMessage,
    signal: AbortSignal
  ): Promise<Response> => {
    const url = `http://${req.headers.host ?? HOST}${req.url ?? "/"}`;
    if (new URL(url).pathname !== ENDPOINT) {
      return new Response("Not found", { status: 404 });
    }
    if (req.headers.origin !== undefined) {
      return new Response("Browser requests are not allowed", { status: 403 });
    }
    const request = await toRequest(req, url, signal);
    return (
      hostHeaderValidationResponse(request, allowedHosts) ??
      (await handler.fetch(request))
    );
  };

  const serve = async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> => {
    const abort = new AbortController();
    res.on("close", () => {
      abort.abort();
    });
    const response = await respond(req, abort.signal);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body === null) {
      res.end();
    } else {
      await writeBody(response.body, res);
    }
  };

  const server = createHttpServer((req, res) => {
    void serve(req, res);
  });
  server.listen(port, HOST);

  return {
    close: async () => {
      if (server.listening) {
        server.close();
        await once(server, "close");
      }
      await handler.close();
    },
  };
};
