import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authenticateBearer } from "./auth/bearer.js";
import type { Principal, TokenStore } from "./auth/tokens.js";
import { AuthError, type ErrorCode } from "./errors.js";
import { createLogger, type Logger } from "./logger.js";
import type { RateLimiter } from "./rate-limit/token-bucket.js";
import type { ServerFactory } from "./server.js";

export interface HttpHandlerOptions {
  factory: ServerFactory;
  tokenStore: TokenStore;
  /** Per-token limiter applied to every MCP request. Omit to disable. */
  rateLimiter?: RateLimiter;
  logger?: Logger;
  /** Endpoint path. Default `/mcp`. */
  path?: string;
  /**
   * Browser origins allowed to call the endpoint. Requests that carry an
   * `Origin` header not in this list get 403, which blocks DNS rebinding
   * attacks against servers bound to localhost. Non-browser clients do not
   * send `Origin` and are unaffected. Default: no browser origins.
   */
  allowedOrigins?: string[];
  /** Maximum request body size. Default 1 MiB. */
  maxBodyBytes?: number;
}

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | "payload_too_large" | "bad_request" | "method_not_allowed",
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** HTTP-level failures use a JSON-RPC error envelope so MCP clients can parse them. */
function sendRpcError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): void {
  const rpcCode = status === 400 ? -32700 : -32000;
  sendJson(res, status, { jsonrpc: "2.0", error: { code: rpcCode, message, data: { code } }, id: null }, headers);
}

async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) {
    throw new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "payload_too_large", `request body exceeds ${limit} bytes`);
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "request body is not valid JSON");
  }
}

/**
 * Returns a Node `(req, res)` listener serving the MCP Streamable HTTP
 * transport in stateless mode: every POST gets a fresh server and transport
 * bound to the caller's principal. Stateless mode keeps horizontal scaling
 * trivial; the trade-off is no server-initiated messages outside a request.
 *
 * Pipeline: request id -> origin check -> method -> bearer auth -> rate
 * limit -> body parse -> MCP.
 */
export function createHttpHandler(options: HttpHandlerOptions) {
  const logger = options.logger ?? createLogger();
  const mcpPath = options.path ?? "/mcp";
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const incomingId = req.headers["x-request-id"];
    const requestId = typeof incomingId === "string" && REQUEST_ID.test(incomingId) ? incomingId : randomUUID();
    res.setHeader("x-request-id", requestId);
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    let principal: Principal | undefined;

    res.on("finish", () => {
      logger.info("http request", {
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        durationMs: Math.round((performance.now() - started) * 100) / 100,
        tokenId: principal?.tokenId,
      });
    });

    try {
      if (path === "/healthz" && req.method === "GET") {
        sendJson(res, 200, { status: "ok" });
        return;
      }
      if (path !== mcpPath) {
        throw new HttpError(404, "not_found", "not found");
      }

      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins.has(origin)) {
        throw new HttpError(403, "forbidden", "origin not allowed");
      }

      if (req.method !== "POST") {
        // Stateless mode: no standalone SSE stream (GET) and no sessions to end (DELETE).
        sendRpcError(res, 405, "method_not_allowed", "method not allowed", { allow: "POST" });
        return;
      }

      principal = await authenticateBearer(options.tokenStore, req.headers.authorization, (reason) =>
        logger.warn("authentication failed", { requestId, reason }),
      );

      if (options.rateLimiter) {
        const decision = await options.rateLimiter.consume(principal.tokenId);
        res.setHeader("ratelimit-limit", String(decision.limit));
        res.setHeader("ratelimit-remaining", String(decision.remaining));
        if (!decision.allowed) {
          const retryAfter = String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000)));
          logger.warn("rate limited", { requestId, tokenId: principal.tokenId });
          sendRpcError(res, 429, "rate_limited", "rate limit exceeded", { "retry-after": retryAfter });
          return;
        }
      }

      const body = await readJsonBody(req, maxBodyBytes);
      const server = options.factory({ principal, requestId });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof AuthError) {
        const challenge = req.headers.authorization
          ? 'Bearer realm="mcp", error="invalid_token"'
          : 'Bearer realm="mcp"';
        sendRpcError(res, err.status, err.status === 401 ? "unauthorized" : "forbidden", err.message, {
          "www-authenticate": challenge,
        });
      } else if (err instanceof HttpError) {
        sendRpcError(res, err.status, err.code, err.message);
      } else {
        logger.error("unhandled error in http handler", { requestId, err });
        sendRpcError(res, 500, "internal", `internal error (request id ${requestId})`);
      }
    }
  };
}

export interface StartHttpOptions extends HttpHandlerOptions {
  port: number;
  host?: string;
}

export interface RunningHttpServer {
  server: Server;
  /** Base URL including the MCP path, e.g. `http://127.0.0.1:3000/mcp`. */
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(options: StartHttpOptions): Promise<RunningHttpServer> {
  const handler = createHttpHandler(options);
  const server = createServer((req, res) => void handler(req, res));
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return {
    server,
    url: `http://${urlHost}:${port}${options.path ?? "/mcp"}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
