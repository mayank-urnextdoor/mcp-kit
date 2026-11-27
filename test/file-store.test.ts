import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTokenStore, mintToken, verifyToken } from "../src/index.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-kit-"));
  path = join(dir, "nested", "tokens.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FileTokenStore", () => {
  it("treats a missing file as empty", async () => {
    expect(await new FileTokenStore(path).list()).toEqual([]);
  });

  it("persists hashes, never plaintext tokens", async () => {
    const store = new FileTokenStore(path);
    const { token, record } = mintToken({ name: "laptop", scopes: ["read"] });
    await store.add(record);

    const raw = await readFile(path, "utf8");
    expect(raw).toContain(record.hash);
    expect(raw).not.toContain(token);
    expect((await verifyToken(new FileTokenStore(path), token)).ok).toBe(true);
  });

  it("picks up changes written by another process", async () => {
    const server = new FileTokenStore(path);
    expect(await server.list()).toHaveLength(0);

    const cli = new FileTokenStore(path);
    const { token, record } = mintToken({ name: "late", scopes: ["read"] });
    await cli.add(record);
    // Force a distinct mtime in case the filesystem has coarse timestamps.
    const later = new Date(Date.now() + 5000);
    await utimes(path, later, later);

    expect((await verifyToken(server, token)).ok).toBe(true);
    await cli.remove(record.id);
    const evenLater = new Date(Date.now() + 10_000);
    await utimes(path, evenLater, evenLater);
    expect((await verifyToken(server, token)).ok).toBe(false);
  });

  it("refuses duplicate ids and reports removal", async () => {
    const store = new FileTokenStore(path);
    const { record } = mintToken({ name: "a", scopes: ["read"] });
    await store.add(record);
    await expect(store.add(record)).rejects.toThrow(/already exists/);
    expect(await store.remove(record.id)).toBe(true);
    expect(await store.remove(record.id)).toBe(false);
  });

  it("fails loudly on a corrupt file", async () => {
    const store = new FileTokenStore(join(dir, "bad.json"));
    await writeFile(join(dir, "bad.json"), JSON.stringify({ version: 1, tokens: [{ id: "nope" }] }));
    await expect(store.list()).rejects.toThrow(/invalid/);
  });
});
