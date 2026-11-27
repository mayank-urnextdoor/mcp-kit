import { describe, expect, it } from "vitest";
import { MemoryRateLimitStore, RateLimiter, takeFromBucket } from "../src/index.js";

function limiter(capacity: number, refillPerSecond: number) {
  let now = 1_000_000;
  const store = new MemoryRateLimitStore({ sweepEvery: 1_000_000 });
  const rl = new RateLimiter({ capacity, refillPerSecond, store, now: () => now });
  return {
    rl,
    store,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe("token bucket", () => {
  it("allows a burst up to capacity, then rejects with retry-after", async () => {
    const { rl } = limiter(3, 1);
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rl.consume("t1"));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0]);
    expect(results[3]).toMatchObject({ limit: 3, retryAfterMs: 1000 });
  });

  it("refills continuously at the configured rate", async () => {
    const { rl, advance } = limiter(2, 4); // one unit every 250ms
    await rl.consume("t");
    await rl.consume("t");
    expect((await rl.consume("t")).allowed).toBe(false);

    advance(200);
    const early = await rl.consume("t");
    expect(early.allowed).toBe(false);
    expect(early.retryAfterMs).toBe(50);

    advance(50);
    expect((await rl.consume("t")).allowed).toBe(true);
  });

  it("never refills beyond capacity", async () => {
    const { rl, advance } = limiter(2, 10);
    advance(60_000);
    expect((await rl.consume("t")).remaining).toBe(1);
  });

  it("isolates keys", async () => {
    const { rl } = limiter(1, 1);
    expect((await rl.consume("a")).allowed).toBe(true);
    expect((await rl.consume("a")).allowed).toBe(false);
    expect((await rl.consume("b")).allowed).toBe(true);
  });

  it("rejected requests do not consume units", async () => {
    const { rl, advance } = limiter(1, 1);
    await rl.consume("t");
    for (let i = 0; i < 5; i++) await rl.consume("t");
    advance(1000);
    expect((await rl.consume("t")).allowed).toBe(true);
  });

  it("supports weighted costs", async () => {
    const { rl } = limiter(5, 1);
    expect((await rl.consume("t", 4)).remaining).toBe(1);
    const denied = await rl.consume("t", 3);
    expect(denied).toMatchObject({ allowed: false, retryAfterMs: 2000 });
  });

  it("tolerates a clock moving backwards", () => {
    const policy = { capacity: 2, refillPerSecond: 1 };
    const { state } = takeFromBucket(undefined, policy, 10_000);
    const { decision } = takeFromBucket(state, policy, 5_000);
    expect(decision).toMatchObject({ allowed: true, remaining: 0 });
  });

  it("sweeps buckets that have fully refilled", async () => {
    const { rl, store, advance, now } = limiter(2, 1);
    await rl.consume("a");
    await rl.consume("b");
    advance(500);
    store.sweep(rl.policy, now());
    expect(store.size).toBe(2);
    advance(1500);
    store.sweep(rl.policy, now());
    expect(store.size).toBe(0);
  });

  it.each([
    { capacity: 0, refillPerSecond: 1 },
    { capacity: 1, refillPerSecond: 0 },
    { capacity: Infinity, refillPerSecond: 1 },
  ])("rejects invalid policy %j", (policy) => {
    expect(() => new RateLimiter(policy)).toThrow();
  });
});
