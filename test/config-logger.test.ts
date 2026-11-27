import { describe, expect, it } from "vitest";
import { createLogger, loadConfig } from "../src/index.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 3000,
      MCP_PATH: "/mcp",
      RATE_LIMIT_CAPACITY: 60,
      RATE_LIMIT_DISABLED: false,
      ALLOWED_ORIGINS: [],
      STDIO_SCOPES: ["read", "write"],
    });
  });

  it("parses lists, numbers and booleans", () => {
    const config = loadConfig({
      PORT: "8080",
      ALLOWED_ORIGINS: "https://a.example, https://b.example",
      RATE_LIMIT_DISABLED: "true",
      STDIO_SCOPES: "read",
    });
    expect(config.PORT).toBe(8080);
    expect(config.ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
    expect(config.RATE_LIMIT_DISABLED).toBe(true);
    expect(config.STDIO_SCOPES).toEqual(["read"]);
  });

  it("fails fast with every problem listed", () => {
    expect(() => loadConfig({ PORT: "abc", LOG_LEVEL: "loud", STDIO_SCOPES: "Bad Scope" })).toThrow(
      /PORT[\s\S]*LOG_LEVEL[\s\S]*STDIO_SCOPES/,
    );
  });
});

describe("createLogger", () => {
  const capture = (level?: "debug" | "info" | "warn" | "error") => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level,
      sink: (l) => lines.push(JSON.parse(l)),
      now: () => new Date("2026-01-01T00:00:00Z"),
    });
    return { logger, lines };
  };

  it("writes one JSON object per line with bindings", () => {
    const { logger, lines } = capture();
    logger.child({ requestId: "r1" }).info("hello", { n: 1 });
    expect(lines).toEqual([{ ts: "2026-01-01T00:00:00.000Z", level: "info", msg: "hello", requestId: "r1", n: 1 }]);
  });

  it("filters by level", () => {
    const { logger, lines } = capture("warn");
    logger.info("skip");
    logger.warn("keep");
    expect(lines.map((l) => l.msg)).toEqual(["keep"]);
  });

  it("redacts secret-looking fields at any depth", () => {
    const { logger, lines } = capture();
    logger.info("req", { headers: { Authorization: "Bearer x" }, nested: [{ token: "t", ok: 1 }] });
    expect(lines[0]).toMatchObject({ headers: { Authorization: "[redacted]" }, nested: [{ token: "[redacted]", ok: 1 }] });
  });

  it("serializes errors with their stack", () => {
    const { logger, lines } = capture();
    logger.error("failed", { err: new Error("boom") });
    expect(lines[0]).toMatchObject({ err: { name: "Error", message: "boom", stack: expect.any(String) } });
  });
});
