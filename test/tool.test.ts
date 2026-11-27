import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ToolError,
  createLogger,
  defineTool,
  invokeTool,
  rawResult,
  silentLogger,
  type AuditEvent,
  type Principal,
} from "../src/index.js";

const reader: Principal = { tokenId: "aaaaaaaaaaaa", name: "reader", scopes: ["read"] };
const writer: Principal = { tokenId: "bbbbbbbbbbbb", name: "writer", scopes: ["read", "write"] };

const echo = defineTool({
  name: "echo",
  description: "Echo a message back.",
  scope: "write",
  input: z.object({ message: z.string().min(1), times: z.number().int().min(1).max(3).default(1) }),
  handler: ({ message, times }) => ({ echoed: Array(times).fill(message).join(" ") }),
});

function ctx(principal: Principal, extra: Partial<Parameters<typeof invokeTool>[2]> = {}) {
  return { principal, requestId: "req-1", logger: silentLogger, ...extra };
}

describe("defineTool", () => {
  it("derives a JSON Schema for tools/list", () => {
    expect(echo.inputJsonSchema).toMatchObject({
      type: "object",
      properties: { message: { type: "string", minLength: 1 }, times: { type: "integer", default: 1 } },
      required: ["message"],
    });
    expect(echo.inputJsonSchema).not.toHaveProperty("$schema");
  });

  it("defaults to an empty input object", () => {
    const ping = defineTool({ name: "ping", description: "Ping.", handler: () => "pong" });
    expect(ping.inputJsonSchema).toMatchObject({ type: "object", properties: {} });
  });

  it.each([
    [{ name: "bad name", description: "x" }, /invalid tool name/],
    [{ name: "ok", description: "  " }, /description/],
  ])("rejects bad definitions %#", (spec, msg) => {
    expect(() => defineTool({ ...spec, handler: () => null })).toThrow(msg);
  });

  it("fails at definition time for schemas JSON Schema cannot express", () => {
    expect(() =>
      defineTool({ name: "t", description: "x", input: z.object({ d: z.date() }), handler: () => null }),
    ).toThrow();
  });
});

describe("invokeTool", () => {
  it("runs the handler with parsed input (defaults applied)", async () => {
    const result = await invokeTool(echo, { message: "hi", times: 2 }, ctx(writer));
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ echoed: "hi hi" });

    const withDefault = await invokeTool(echo, { message: "hi" }, ctx(writer));
    expect(withDefault.structuredContent).toEqual({ echoed: "hi" });
  });

  it("enforces scope before validating or running anything", async () => {
    const handler = vi.fn();
    const tool = defineTool({ name: "w", description: "x", scope: "write", input: z.object({ a: z.string() }), handler });
    const result = await invokeTool(tool, { a: 1 }, ctx(reader));
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      error: { code: "forbidden", message: 'tool "w" requires scope "write"' },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns structured validation errors with paths", async () => {
    const result = await invokeTool(echo, { message: "", times: 9, extra: true }, ctx(writer));
    expect(result.isError).toBe(true);
    const error = (result.structuredContent as { error: { code: string; details: { issues: { path: string }[] } } }).error;
    expect(error.code).toBe("invalid_input");
    expect(error.details.issues.map((i) => i.path).sort()).toEqual(["message", "times"]);
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("invalid_input") });
  });

  it("treats missing arguments as an empty object", async () => {
    const result = await invokeTool(echo, undefined, ctx(writer));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain('"path":"message"');
  });

  it("maps ToolError to a client-visible error", async () => {
    const tool = defineTool({
      name: "missing",
      description: "x",
      handler: () => {
        throw new ToolError("not_found", "no such thing", { id: 7 });
      },
    });
    const result = await invokeTool(tool, {}, ctx(reader));
    expect(result.structuredContent).toEqual({ error: { code: "not_found", message: "no such thing", details: { id: 7 } } });
  });

  it("hides unexpected errors from the client but logs them", async () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const tool = defineTool({
      name: "boom",
      description: "x",
      handler: async () => {
        throw new Error("db password is hunter2");
      },
    });
    const result = await invokeTool(tool, {}, ctx(reader, { logger, requestId: "req-42" }));
    expect(result.structuredContent).toEqual({
      error: { code: "internal", message: "internal error (request id req-42)" },
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    const logged = lines.map((l) => JSON.parse(l)).find((l) => l.msg === "tool handler threw");
    expect(logged).toMatchObject({ level: "error", tool: "boom", requestId: "req-42", err: { message: "db password is hunter2" } });
  });

  it("shapes return values", async () => {
    const run = (value: unknown) =>
      invokeTool(defineTool({ name: "v", description: "x", handler: () => value }), {}, ctx(reader));

    expect(await run("plain")).toEqual({ content: [{ type: "text", text: "plain" }] });
    expect(await run(undefined)).toEqual({ content: [{ type: "text", text: "ok" }] });
    const arr = await run([1, 2]);
    expect(arr.structuredContent).toBeUndefined();
    expect(arr.content[0]).toMatchObject({ text: "[\n  1,\n  2\n]" });
    const raw = { content: [{ type: "image" as const, data: "AAAA", mimeType: "image/png" }] };
    expect(await run(rawResult(raw))).toBe(raw);
  });

  it("passes principal, request id and abort signal to the handler", async () => {
    const seen = vi.fn();
    const tool = defineTool({ name: "who", description: "x", handler: (_input, c) => seen(c) });
    const controller = new AbortController();
    await invokeTool(tool, {}, ctx(writer, { signal: controller.signal, requestId: "r9" }));
    expect(seen).toHaveBeenCalledWith(
      expect.objectContaining({ principal: writer, requestId: "r9", signal: controller.signal }),
    );
  });

  it("emits one audit event per call, for success and failure", async () => {
    const events: AuditEvent[] = [];
    const audit = (e: AuditEvent) => {
      events.push(e);
    };
    await invokeTool(echo, { message: "a" }, ctx(writer, { audit }));
    await invokeTool(echo, { message: "a" }, ctx(reader, { audit }));
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ tool: "echo", tokenId: writer.tokenId, tokenName: "writer", outcome: "ok", requestId: "req-1" });
    expect(events[0]).not.toHaveProperty("errorCode");
    expect(events[1]).toMatchObject({ outcome: "error", errorCode: "forbidden", tokenId: reader.tokenId });
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("never lets a failing audit hook break the call", async () => {
    const audit = () => Promise.reject(new Error("audit sink down"));
    const result = await invokeTool(echo, { message: "a" }, ctx(writer, { audit }));
    expect(result.isError).toBeUndefined();
  });
});
