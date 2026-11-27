import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotesStore } from "../examples/notes-server/notes-store.js";
import { notesTools } from "../examples/notes-server/tools.js";
import {
  InMemoryTokenStore,
  RateLimiter,
  createLogger,
  createServerFactory,
  mintToken,
  startHttpServer,
  type RunningHttpServer,
} from "../src/index.js";

let running: RunningHttpServer;
let tokens: { rw: string; ro: string };
let logLines: Record<string, unknown>[];
let clock: number;
const clients: Client[] = [];

beforeEach(async () => {
  const rw = mintToken({ name: "rw", scopes: ["read", "write"] });
  const ro = mintToken({ name: "ro", scopes: ["read"] });
  tokens = { rw: rw.token, ro: ro.token };
  logLines = [];
  clock = 0;
  const logger = createLogger({ level: "debug", sink: (l) => logLines.push(JSON.parse(l)) });
  running = await startHttpServer({
    port: 0,
    factory: createServerFactory({ name: "notes", version: "0.0.0", tools: notesTools(new NotesStore()), logger }),
    tokenStore: new InMemoryTokenStore([rw.record, ro.record]),
    rateLimiter: new RateLimiter({ capacity: 5, refillPerSecond: 1, now: () => clock }),
    allowedOrigins: ["https://allowed.example"],
    maxBodyBytes: 4096,
    logger,
  });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await running.close();
});

async function client(token: string) {
  const c = new Client({ name: "http-test", version: "0.0.0" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(running.url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  clients.push(c);
  return c;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(running.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list" };

describe("HTTP transport", () => {
  it("serves the notes tools to an authenticated SDK client", async () => {
    const c = await client(tokens.rw);
    const created = await c.callTool({ name: "create_note", arguments: { title: "Groceries", tags: ["home"] } });
    expect(created.isError).toBeUndefined();
    const id = (created.structuredContent as { id: string }).id;

    const listed = await c.callTool({ name: "list_notes", arguments: { tag: "home" } });
    expect(listed.structuredContent).toMatchObject({ count: 1, notes: [{ id, title: "Groceries", createdBy: "rw" }] });

    const missing = await c.callTool({ name: "get_note", arguments: { id: "00000000-0000-4000-8000-000000000000" } });
    expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });

  it("filters tools/list by token scope", async () => {
    const ro = await client(tokens.ro);
    expect((await ro.listTools()).tools.map((t) => t.name).sort()).toEqual(["get_note", "list_notes"]);
    const denied = await ro.callTool({ name: "delete_note", arguments: { id: "00000000-0000-4000-8000-000000000000" } });
    expect(denied.structuredContent).toMatchObject({ error: { code: "forbidden" } });
  });

  it("rejects missing and invalid tokens with 401 and a Bearer challenge", async () => {
    const missing = await post(listTools);
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toBe('Bearer realm="mcp"');
    expect(await missing.json()).toMatchObject({ error: { data: { code: "unauthorized" } } });

    const forged = tokens.rw.slice(0, -4) + "AAAA";
    const bad = await post(listTools, { authorization: `Bearer ${forged}` });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(logLines.some((l) => l.msg === "authentication failed" && l.reason === "mismatch")).toBe(true);
  });

  it("never writes tokens to the log", async () => {
    await post(listTools, { authorization: `Bearer ${tokens.rw}` });
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(tokens.rw);
    expect(all).toContain('"msg":"http request"');
  });

  it("rate limits per token and recovers after refill", async () => {
    const auth = { authorization: `Bearer ${tokens.ro}` };
    for (let i = 0; i < 5; i++) {
      const ok = await post(listTools, auth);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("ratelimit-remaining")).toBe(String(4 - i));
    }
    const limited = await post(listTools, auth);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(await limited.json()).toMatchObject({ error: { data: { code: "rate_limited" } } });

    // A different token has its own bucket.
    expect((await post(listTools, { authorization: `Bearer ${tokens.rw}` })).status).toBe(200);

    clock += 1000;
    expect((await post(listTools, auth)).status).toBe(200);
  });

  it("blocks disallowed browser origins before authentication", async () => {
    const auth = { authorization: `Bearer ${tokens.rw}` };
    expect((await post(listTools, { ...auth, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(listTools, { ...auth, origin: "https://allowed.example" })).status).toBe(200);
  });

  it("propagates a sane X-Request-Id and replaces an unsafe one", async () => {
    const auth = { authorization: `Bearer ${tokens.rw}` };
    const kept = await post(listTools, { ...auth, "x-request-id": "trace-abc.123" });
    expect(kept.headers.get("x-request-id")).toBe("trace-abc.123");
    const replaced = await post(listTools, { ...auth, "x-request-id": "bad id\twith spaces" });
    expect(replaced.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("rejects oversized and malformed bodies", async () => {
    const auth = { authorization: `Bearer ${tokens.rw}` };
    const big = await post({ ...listTools, params: { pad: "x".repeat(5000) } }, auth);
    expect(big.status).toBe(413);
    const malformed = await post("{not json", auth);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
  });

  it("only accepts POST on the MCP path and serves a health check", async () => {
    const get = await fetch(running.url, { headers: { authorization: `Bearer ${tokens.rw}` } });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const health = await fetch(new URL("/healthz", running.url));
    expect(await health.json()).toEqual({ status: "ok" });
    expect((await fetch(new URL("/other", running.url))).status).toBe(404);
  });
});
