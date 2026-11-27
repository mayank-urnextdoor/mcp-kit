import { AuthError } from "../errors.js";
import { verifyToken, type Principal, type TokenStore, type VerifyFailure } from "./tokens.js";

/**
 * Extracts the token from an `Authorization: Bearer <token>` header value.
 * Returns undefined when the header is absent, repeated, or uses another scheme.
 */
export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  if (header === undefined || Array.isArray(header)) return undefined;
  const match = /^Bearer +(\S+) *$/i.exec(header);
  return match?.[1];
}

/**
 * Resolves the request principal or throws `AuthError(401)`.
 *
 * The error message is the same for every failure so a response never reveals
 * whether a token id exists. The precise reason goes to `onFailure`, for
 * server-side logs only.
 */
export async function authenticateBearer(
  store: TokenStore,
  header: string | string[] | undefined,
  onFailure?: (reason: VerifyFailure | "missing") => void,
  now: Date = new Date(),
): Promise<Principal> {
  const token = extractBearerToken(header);
  if (!token) {
    onFailure?.("missing");
    throw new AuthError(401, "missing or invalid bearer token");
  }
  const result = await verifyToken(store, token, now);
  if (!result.ok) {
    onFailure?.(result.reason);
    throw new AuthError(401, "missing or invalid bearer token");
  }
  return result.principal;
}
