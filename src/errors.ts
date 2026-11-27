/**
 * Error codes surfaced to MCP clients. They are stable strings so that agents
 * and humans can branch on them without parsing prose.
 */
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "conflict"
  | "internal";

export interface ToolErrorPayload {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

/**
 * Throw this from a tool handler to return a structured, client-visible error.
 * Any other thrown value is treated as a bug: it is logged with its stack and
 * the client only sees a generic `internal` error.
 */
export class ToolError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  toPayload(): ToolErrorPayload {
    const payload: ToolErrorPayload = { code: this.code, message: this.message };
    if (this.details !== undefined) payload.details = this.details;
    return payload;
  }
}

/** Raised by the HTTP auth layer; mapped to 401/403 responses. */
export class AuthError extends Error {
  readonly status: 401 | 403;

  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}
