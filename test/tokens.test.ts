import { describe, expect, it } from "vitest";
import {
  InMemoryTokenStore,
  authenticateBearer,
  constantTimeEqualHex,
  extractBearerToken,
  hasScope,
  hashToken,
  mintToken,
  parseToken,
  verifyToken,
} from "../src/index.js";

const NOW = new Date("2026-01-01T00:00:00Z");

async function storeWith(...scopes: string[]) {
  const minted = mintToken({ name: "test", scopes, now: NOW });
  const store = new InMemoryTokenStore([minted.record]);
  return { store, ...minted };
}

describe("mintToken", () => {
  it("produces mcpk_<id>_<secret> and stores only the hash", () => {
    const { token, record } = mintToken({ name: "ci", scopes: ["write", "read", "read"], now: NOW });
    expect(token).toMatch(/^mcpk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(record.hash).toBe(hashToken(token));
    expect(JSON.stringify(record)).not.toContain(token.split("_").slice(2).join("_"));
    expect(record.scopes).toEqual(["read", "write"]);
    expect(record.expiresAt).toBeUndefined();
  });

  it("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintToken({ name: "x", scopes: ["read"] }).token));
    expect(tokens.size).toBe(200);
  });

  it("sets expiry from ttl", () => {
    const { record } = mintToken({ name: "x", scopes: ["read"], ttlMs: 60_000, now: NOW });
    expect(record.expiresAt).toBe("2026-01-01T00:01:00.000Z");
  });

  it.each([
    [{ name: " ", scopes: ["read"] }, /name/],
    [{ name: "x", scopes: [] }, /scope/],
    [{ name: "x", scopes: ["Read Write"] }, /invalid scope/],
    [{ name: "x", scopes: ["read"], ttlMs: 0 }, /ttlMs/],
  ])("rejects bad options %#", (opts, msg) => {
    expect(() => mintToken(opts)).toThrow(msg);
  });
});

describe("parseToken", () => {
  it("accepts secrets that contain underscores", () => {
    const secret = "a_b-".padEnd(43, "x");
    expect(parseToken(`mcpk_0123456789ab_${secret}`)).toEqual({ id: "0123456789ab", secret });
  });

  it.each(["", "mcpk_", "nope_0123456789ab_" + "x".repeat(43), "mcpk_0123456789ab", "mcpk_XYZ_" + "x".repeat(43), "mcpk_0123456789ab_short"])(
    "rejects malformed %j",
    (t) => {
      expect(parseToken(t)).toBeUndefined();
    },
  );
});

describe("constantTimeEqualHex", () => {
  it("compares digests", () => {
    const a = hashToken("a");
    expect(constantTimeEqualHex(a, a)).toBe(true);
    expect(constantTimeEqualHex(a, hashToken("b"))).toBe(false);
  });

  it("returns false instead of throwing on length mismatch", () => {
    expect(constantTimeEqualHex(hashToken("a"), "abcd")).toBe(false);
    expect(constantTimeEqualHex("", "")).toBe(false);
  });
});

describe("verifyToken", () => {
  it("returns the principal for a valid token", async () => {
    const { store, token, record } = await storeWith("read", "write");
    const result = await verifyToken(store, token, NOW);
    expect(result).toEqual({ ok: true, principal: { tokenId: record.id, name: "test", scopes: ["read", "write"] } });
  });

  it("rejects a wrong secret for a known id", async () => {
    const { store, record } = await storeWith("read");
    const forged = `mcpk_${record.id}_${"A".repeat(43)}`;
    expect(await verifyToken(store, forged, NOW)).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects unknown ids and malformed tokens", async () => {
    const { store } = await storeWith("read");
    const other = mintToken({ name: "other", scopes: ["read"] }).token;
    expect(await verifyToken(store, other, NOW)).toEqual({ ok: false, reason: "unknown" });
    expect(await verifyToken(store, "garbage", NOW)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects expired tokens at and after expiry", async () => {
    const { token, record } = mintToken({ name: "t", scopes: ["read"], ttlMs: 1000, now: NOW });
    const store = new InMemoryTokenStore([record]);
    expect((await verifyToken(store, token, new Date(NOW.getTime() + 999))).ok).toBe(true);
    expect(await verifyToken(store, token, new Date(NOW.getTime() + 1000))).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects revoked tokens", async () => {
    const { store, token, record } = await storeWith("read");
    await store.remove(record.id);
    expect((await verifyToken(store, token, NOW)).ok).toBe(false);
  });
});

describe("hasScope", () => {
  const principal = { tokenId: "x", name: "x", scopes: ["read"] };
  it("checks membership and allows unscoped tools", () => {
    expect(hasScope(principal, "read")).toBe(true);
    expect(hasScope(principal, "write")).toBe(false);
    expect(hasScope(principal, undefined)).toBe(true);
  });
});

describe("bearer header handling", () => {
  it.each([
    ["Bearer abc", "abc"],
    ["bearer abc", "abc"],
    ["Bearer   abc  ", "abc"],
  ])("extracts from %j", (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });

  it.each([undefined, "", "Basic abc", "Bearer", "Bearer a b", ["Bearer a", "Bearer b"]])("rejects %j", (header) => {
    expect(extractBearerToken(header)).toBeUndefined();
  });

  it("authenticates and reports failure reasons without leaking them", async () => {
    const { store, token } = await storeWith("read");
    await expect(authenticateBearer(store, `Bearer ${token}`)).resolves.toMatchObject({ name: "test" });

    const reasons: string[] = [];
    const onFailure = (r: string) => reasons.push(r);
    const errors = await Promise.all(
      [undefined, "Bearer nope", `Bearer mcpk_000000000000_${"A".repeat(43)}`].map((h) =>
        authenticateBearer(store, h, onFailure).catch((e: unknown) => e),
      ),
    );
    expect(reasons).toEqual(["missing", "malformed", "unknown"]);
    for (const err of errors) {
      expect(err).toMatchObject({ status: 401, message: "missing or invalid bearer token" });
    }
  });
});
