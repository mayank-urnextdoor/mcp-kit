/**
 * Token bucket rate limiting.
 *
 * Each key (a token id) owns a bucket holding up to `capacity` units. Units
 * refill continuously at `refillPerSecond`. A request costs one unit by
 * default; it is allowed if the bucket has enough units, otherwise rejected
 * with the time until enough units will have refilled.
 *
 * The math lives in `takeFromBucket`, a pure function, so any store (in-memory,
 * Redis via a Lua script, a database row) can share the exact same semantics.
 */

export interface BucketPolicy {
  /** Maximum burst size. */
  capacity: number;
  /** Sustained rate, in units per second. */
  refillPerSecond: number;
}

export interface BucketState {
  units: number;
  updatedAtMs: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  /** Whole units left after this request. */
  remaining: number;
  /** 0 when allowed; otherwise ms until the request would succeed. */
  retryAfterMs: number;
}

export function validatePolicy(policy: BucketPolicy): void {
  if (!(policy.capacity >= 1) || !Number.isFinite(policy.capacity)) {
    throw new Error("rate limit capacity must be a finite number >= 1");
  }
  if (!(policy.refillPerSecond > 0) || !Number.isFinite(policy.refillPerSecond)) {
    throw new Error("rate limit refillPerSecond must be a finite number > 0");
  }
}

export function takeFromBucket(
  state: BucketState | undefined,
  policy: BucketPolicy,
  nowMs: number,
  cost = 1,
): { state: BucketState; decision: RateLimitDecision } {
  const prev = state ?? { units: policy.capacity, updatedAtMs: nowMs };
  // Guard against clocks moving backwards.
  const elapsedMs = Math.max(0, nowMs - prev.updatedAtMs);
  const units = Math.min(policy.capacity, prev.units + (elapsedMs / 1000) * policy.refillPerSecond);

  if (units >= cost) {
    const next = { units: units - cost, updatedAtMs: nowMs };
    return {
      state: next,
      decision: {
        allowed: true,
        limit: policy.capacity,
        remaining: Math.floor(next.units),
        retryAfterMs: 0,
      },
    };
  }

  const deficit = cost - units;
  return {
    state: { units, updatedAtMs: nowMs },
    decision: {
      allowed: false,
      limit: policy.capacity,
      remaining: 0,
      retryAfterMs: Math.ceil((deficit / policy.refillPerSecond) * 1000),
    },
  };
}

/**
 * Pluggable storage for bucket state. `consume` must be atomic per key: a
 * shared-store implementation should run the read-modify-write in one step
 * (for example a Redis Lua script that ports `takeFromBucket`).
 */
export interface RateLimitStore {
  consume(key: string, policy: BucketPolicy, nowMs: number, cost: number): Promise<RateLimitDecision>;
}

export interface MemoryRateLimitStoreOptions {
  /** Sweep idle buckets every N calls. Default 1000. */
  sweepEvery?: number;
}

/**
 * Single-process store. Node runs `consume` to completion without yielding, so
 * the read-modify-write is atomic. Buckets that have been idle long enough to
 * be full again are equivalent to absent ones and get swept.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, BucketState>();
  private readonly sweepEvery: number;
  private calls = 0;

  constructor(options: MemoryRateLimitStoreOptions = {}) {
    this.sweepEvery = options.sweepEvery ?? 1000;
  }

  async consume(key: string, policy: BucketPolicy, nowMs: number, cost: number): Promise<RateLimitDecision> {
    const { state, decision } = takeFromBucket(this.buckets.get(key), policy, nowMs, cost);
    this.buckets.set(key, state);
    if (++this.calls % this.sweepEvery === 0) this.sweep(policy, nowMs);
    return decision;
  }

  /** Number of tracked buckets; exposed for tests and metrics. */
  get size(): number {
    return this.buckets.size;
  }

  sweep(policy: BucketPolicy, nowMs: number): void {
    for (const [key, s] of this.buckets) {
      const refilled = s.units + ((nowMs - s.updatedAtMs) / 1000) * policy.refillPerSecond;
      if (refilled >= policy.capacity) this.buckets.delete(key);
    }
  }
}

export interface RateLimiterOptions extends BucketPolicy {
  store?: RateLimitStore;
  now?: () => number;
}

export class RateLimiter {
  readonly policy: BucketPolicy;
  private readonly store: RateLimitStore;
  private readonly now: () => number;

  constructor(options: RateLimiterOptions) {
    this.policy = { capacity: options.capacity, refillPerSecond: options.refillPerSecond };
    validatePolicy(this.policy);
    this.store = options.store ?? new MemoryRateLimitStore();
    this.now = options.now ?? Date.now;
  }

  consume(key: string, cost = 1): Promise<RateLimitDecision> {
    return this.store.consume(key, this.policy, this.now(), cost);
  }
}
