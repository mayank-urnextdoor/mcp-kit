import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createServerFactory, defineTool, localPrincipal, silentLogger, type AuditEvent } from "../src/index.js";

const tools = [
  defineTool({ name: "read_thing", description: "Read.", scope: "read", handler: () => "r" }),
  defineTool({
    name: "write_thing",
    description: "Write.",
    scope: "write",
    input: z.object({ v: z.string() }),
    handler: ({ v }) => ({ wrote: v }),
  }),
  defineTool({ name: "open_thing", description: "No scope needed.", handler: () => "o" }),
];

const clients: Client[] = [];

async function connect(scopes: string[], audit?: (e: AuditEvent) => void) {
  const factory = createServerFactory({ name: "test", version: "0.0.0", tools, logger: silentLogger, audit });
  const server = factory({ principal: localPrincipal(scopes) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientSide);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

describe("createServerFactory", () => {
  it("lists only the tools the principal may call", async () => {
    const reader = await connect(["read"]);
    expect((await reader.listTools()).tools.map((t) => t.name)).toEqual(["read_thing", "open_thing"]);

    const writer = await connect(["read", "write"]);
    const listed = (await writer.listTools()).tools;
    expect(listed.map((t) => t.name)).toEqual(["read_thing", "write_thing", "open_thing"]);
    expect(listed[1]?.inputSchema).toMatchObject({ type: "object", required: ["v"] });
  });

  it("still enforces scope when an unlisted tool is called directly", async () => {
    const reader = await connect(["read"]);
    const result = await reader.callTool({ name: "write_thing", arguments: { v: "x" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ error: { code: "forbidden" } });
  });

  it("calls tools end to end through the MCP client", async () => {
    const writer = await connect(["read", "write"]);
    const result = await writer.callTool({ name: "write_thing", arguments: { v: "hello" } });
    expect(result.structuredContent).toEqual({ wrote: "hello" });
  });

  it("returns a protocol error for unknown tools", async () => {
    const client = await connect(["read"]);
    await expect(client.callTool({ name: "nope", arguments: {} })).rejects.toThrow(/unknown tool: nope/);
  });

  it("gives each stdio call its own request id in audit events", async () => {
    const events: AuditEvent[] = [];
    const client = await connect(["read"], (e) => events.push(e));
    await client.callTool({ name: "read_thing", arguments: {} });
    await client.callTool({ name: "read_thing", arguments: {} });
    expect(events).toHaveLength(2);
    expect(events[0]!.requestId).not.toBe(events[1]!.requestId);
    expect(events[0]!.tokenId).toBe("stdio");
  });

  it("rejects duplicate tool names at startup", () => {
    expect(() =>
      createServerFactory({ name: "x", version: "0", tools: [tools[0]!, tools[0]!], logger: silentLogger }),
    ).toThrow(/duplicate tool name/);
  });
});
