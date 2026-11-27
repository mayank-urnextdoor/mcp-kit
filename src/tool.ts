import { performance } from "node:perf_hooks";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hasScope, type Principal } from "./auth/tokens.js";
import { ToolError, type ToolErrorPayload } from "./errors.js";
import type { Logger } from "./logger.js";

export interface ToolContext {
  principal: Principal;
  /** Correlates logs, audit events and error messages for one request. */
  requestId: string;
  /** Logger pre-bound with `requestId`, `tool` and `tokenId`. */
  logger: Logger;
  /** Aborted when the client cancels the request or disconnects. */
  signal: AbortSignal;
}

type ObjectSchema = z.ZodObject;

export interface ToolSpec<S extends ObjectSchema> {
  /** Tool name as seen by the client. Letters, digits, `_` and `-`. */
  name: string;
  title?: string;
  description: string;
  /** Scope the caller's token must hold. Omit for tools any token may call. */
  scope?: string;
  /** Zod object schema for the arguments. Defaults to "no arguments". */
  input?: S;
  annotations?: ToolAnnotations;
  /**
   * Receives validated, typed input. Return a string (sent as text), a plain
   * object (sent as JSON text and as `structuredContent`), any other
   * JSON-serializable value, or `rawResult(...)` for full control.
   * Throw `ToolError` for expected failures.
   */
  handler: (input: z.output<S>, ctx: ToolContext) => unknown;
}

/** A tool after `defineTool`: type-erased so tools with different inputs share one array. */
export interface Tool {
  readonly name: string;
  readonly title: string | undefined;
  readonly description: string;
  readonly scope: string | undefined;
  readonly annotations: ToolAnnotations | undefined;
  readonly inputSchema: ObjectSchema;
  /** JSON Schema advertised in `tools/list`, computed once at definition time. */
  readonly inputJsonSchema: { type: "object"; [key: string]: unknown };
  readonly handler: (input: unknown, ctx: ToolContext) => unknown;
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export function defineTool<S extends ObjectSchema = z.ZodObject<Record<string, never>>>(
  spec: ToolSpec<S>,
): Tool {
  if (!TOOL_NAME.test(spec.name)) {
    throw new Error(`invalid tool name ${JSON.stringify(spec.name)}: use 1-64 of [A-Za-z0-9_-]`);
  }
  if (!spec.description.trim()) {
    throw new Error(`tool ${spec.name} needs a description; models rely on it to pick tools`);
  }
  const inputSchema: ObjectSchema = spec.input ?? z.object({});
  // Throws for schemas that JSON Schema cannot express (e.g. transforms with
  // no input type), surfacing the problem at startup rather than at call time.
  const { $schema: _ignored, ...json } = z.toJSONSchema(inputSchema, { target: "draft-07", io: "input" });

  return Object.freeze({
    name: spec.name,
    title: spec.title,
    description: spec.description,
    scope: spec.scope,
    annotations: spec.annotations,
    inputSchema,
    inputJsonSchema: { ...json, type: "object" as const },
    handler: spec.handler as (input: unknown, ctx: ToolContext) => unknown,
  });
}

const RAW = Symbol("mcp-kit.rawResult");

interface RawResult {
  [RAW]: CallToolResult;
}

/** Return this from a handler to send a `CallToolResult` verbatim (images, multiple parts, ...). */
export function rawResult(result: CallToolResult): RawResult {
  return { [RAW]: result };
}

function isRawResult(value: unknown): value is RawResult {
  return typeof value === "object" && value !== null && RAW in value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function toCallToolResult(value: unknown): CallToolResult {
  if (isRawResult(value)) return value[RAW];
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (value === undefined) return { content: [{ type: "text", text: "ok" }] };
  const text = JSON.stringify(value, null, 2);
  if (isPlainObject(value)) {
    return { content: [{ type: "text", text }], structuredContent: value };
  }
  return { content: [{ type: "text", text }] };
}

export function errorResult(payload: ToolErrorPayload): CallToolResult {
  let text = `${payload.code}: ${payload.message}`;
  if (payload.details !== undefined) text += `\n${JSON.stringify(payload.details, null, 2)}`;
  return {
    isError: true,
    content: [{ type: "text", text }],
    structuredContent: { error: { ...payload } },
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export function formatIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.length ? issue.path.map(String).join(".") : "(root)",
    message: issue.message,
  }));
}

export interface AuditEvent {
  ts: string;
  requestId: string;
  tokenId: string;
  tokenName: string;
  tool: string;
  outcome: "ok" | "error";
  errorCode?: ToolErrorPayload["code"];
  durationMs: number;
}

/**
 * Called once per tool call, after it finishes. Arguments and results are not
 * included on purpose: they may hold user data. Add them in your own hook if
 * your retention policy allows it. Hook failures are logged, never surfaced.
 */
export type AuditHook = (event: AuditEvent) => void | Promise<void>;

export interface InvokeContext {
  principal: Principal;
  requestId: string;
  logger: Logger;
  signal?: AbortSignal;
  audit?: AuditHook;
  now?: () => Date;
}

/**
 * The tool call pipeline: scope check, input validation, handler, result
 * shaping, audit. Transport-independent so it can be tested directly.
 */
export async function invokeTool(tool: Tool, rawArgs: unknown, ctx: InvokeContext): Promise<CallToolResult> {
  const started = performance.now();
  const logger = ctx.logger.child({ tool: tool.name, tokenId: ctx.principal.tokenId, requestId: ctx.requestId });
  let result: CallToolResult;
  let errorCode: ToolErrorPayload["code"] | undefined;

  try {
    if (!hasScope(ctx.principal, tool.scope)) {
      throw new ToolError("forbidden", `tool "${tool.name}" requires scope "${tool.scope}"`);
    }
    const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      throw new ToolError("invalid_input", `invalid arguments for "${tool.name}"`, {
        issues: formatIssues(parsed.error),
      });
    }
    const value = await tool.handler(parsed.data, {
      principal: ctx.principal,
      requestId: ctx.requestId,
      logger,
      signal: ctx.signal ?? new AbortController().signal,
    });
    result = toCallToolResult(value);
  } catch (err) {
    if (err instanceof ToolError) {
      errorCode = err.code;
      logger.info("tool returned error", { code: err.code, message: err.message });
      result = errorResult(err.toPayload());
    } else {
      // Unexpected: log everything, tell the client nothing beyond a reference.
      errorCode = "internal";
      logger.error("tool handler threw", { err });
      result = errorResult({
        code: "internal",
        message: `internal error (request id ${ctx.requestId})`,
      });
    }
  }

  const durationMs = Math.round((performance.now() - started) * 100) / 100;
  if (ctx.audit) {
    const event: AuditEvent = {
      ts: (ctx.now?.() ?? new Date()).toISOString(),
      requestId: ctx.requestId,
      tokenId: ctx.principal.tokenId,
      tokenName: ctx.principal.name,
      tool: tool.name,
      outcome: errorCode ? "error" : "ok",
      durationMs,
    };
    if (errorCode) event.errorCode = errorCode;
    try {
      await ctx.audit(event);
    } catch (err) {
      logger.error("audit hook failed", { err });
    }
  }
  return result;
}
