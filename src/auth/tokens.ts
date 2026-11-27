import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Token wire format: `mcpk_<id>_<secret>`.
 *
 * - `id` is a public, random lookup key (12 hex chars). It lets us fetch the
 *   one candidate record directly instead of comparing against every stored
 *   hash, and it is safe to show in logs and audit events.
 * - `secret` is 32 random bytes, base64url encoded (43 chars).
 *
 * Only SHA-256(token) is persisted. A fast hash is appropriate here (unlike for
 * passwords) because the secret has 256 bits of entropy, so brute-forcing a
 * leaked hash is not feasible.
 */
export const TOKEN_PREFIX = "mcpk_";
const ID_PATTERN = /^[0-9a-f]{12}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9:._-]{0,63}$/;

export interface TokenRecord {
  id: string;
  /** Human label, e.g. "claude-desktop-laptop". */
  name: string;
  scopes: string[];
  /** Hex-encoded SHA-256 of the full token string. */
  hash: string;
  createdAt: string;
  /** ISO timestamp; omitted means the token does not expire. */
  expiresAt?: string;
}

export interface TokenStore {
  findById(id: string): Promise<TokenRecord | undefined>;
  add(record: TokenRecord): Promise<void>;
  remove(id: string): Promise<boolean>;
  list(): Promise<TokenRecord[]>;
}

/** The authenticated identity attached to a request. Never contains the secret. */
export interface Principal {
  tokenId: string;
  name: string;
  scopes: readonly string[];
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export interface MintOptions {
  name: string;
  scopes: string[];
  /** Lifetime in milliseconds. Omit for a non-expiring token. */
  ttlMs?: number;
  now?: Date;
}

export interface MintedToken {
  /** The plaintext token. Show it once; it cannot be recovered later. */
  token: string;
  record: TokenRecord;
}

export function isValidScope(scope: string): boolean {
  return SCOPE_PATTERN.test(scope);
}

export function mintToken(options: MintOptions): MintedToken {
  const name = options.name.trim();
  if (!name) throw new Error("token name must not be empty");
  if (options.scopes.length === 0) throw new Error("at least one scope is required");
  for (const scope of options.scopes) {
    if (!isValidScope(scope)) throw new Error(`invalid scope: ${JSON.stringify(scope)}`);
  }
  if (options.ttlMs !== undefined && !(options.ttlMs > 0)) {
    throw new Error("ttlMs must be a positive number");
  }

  const now = options.now ?? new Date();
  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const token = `${TOKEN_PREFIX}${id}_${secret}`;

  const record: TokenRecord = {
    id,
    name,
    scopes: [...new Set(options.scopes)].sort(),
    hash: hashToken(token),
    createdAt: now.toISOString(),
  };
  if (options.ttlMs !== undefined) {
    record.expiresAt = new Date(now.getTime() + options.ttlMs).toISOString();
  }
  return { token, record };
}

/** Splits a token into its parts, or returns undefined if it is malformed. */
export function parseToken(token: string): { id: string; secret: string } | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) return undefined;
  const rest = token.slice(TOKEN_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep === -1) return undefined;
  const id = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!ID_PATTERN.test(id) || !SECRET_PATTERN.test(secret)) return undefined;
  return { id, secret };
}

/** Compares two hex digests in constant time. */
export function constantTimeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  // timingSafeEqual throws on a length mismatch. Both inputs are SHA-256
  // digests in normal operation, so this only happens with a corrupt record.
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return timingSafeEqual(bufA, bufB);
}

// Compared against when the token id is unknown, so that an unknown id and a
// wrong secret cost the same amount of work.
const DUMMY_HASH = hashToken(`${TOKEN_PREFIX}000000000000_${"A".repeat(43)}`);

export type VerifyFailure = "malformed" | "unknown" | "mismatch" | "expired";

export type VerifyResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: VerifyFailure };

export async function verifyToken(
  store: TokenStore,
  token: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const parsed = parseToken(token);
  if (!parsed) return { ok: false, reason: "malformed" };

  const presentedHash = hashToken(token);
  const record = await store.findById(parsed.id);
  if (!record) {
    constantTimeEqualHex(presentedHash, DUMMY_HASH);
    return { ok: false, reason: "unknown" };
  }
  if (!constantTimeEqualHex(presentedHash, record.hash)) {
    return { ok: false, reason: "mismatch" };
  }
  if (record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return {
    ok: true,
    principal: { tokenId: record.id, name: record.name, scopes: [...record.scopes] },
  };
}

/** True when the principal holds `required`, or when no scope is required. */
export function hasScope(principal: Principal, required: string | undefined): boolean {
  return required === undefined || principal.scopes.includes(required);
}
