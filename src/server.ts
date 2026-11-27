import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool as McpToolDescriptor,
} from "@modelcontextprotocol/sdk/types.js";
import { hasScope, type Principal } from "./auth/tokens.js";
import { createLogger, type Logger } from "./logger.js";
import { invokeTool, type AuditHook, type Tool } from "./tool.js";

export interface McpKitOptions {
  name: string;
  version: string;
  /** Optional server instructions sent to the client during initialization. */
  instructions?: string;
  tools: Tool[];
  logger?: Logger;
  /** Receives one event per tool call. Defaults to an `audit` log line. */
  audit?: AuditHook;
  /**
   * Hook for registering resources and prompts on the underlying `McpServer`.
   * Register tools with `defineTool` instead of `server.registerTool`: mcp-kit
   * owns the tools/list and tools/call handlers.
   */
  setup?: (server: McpServer) => void;
}

export interface SessionContext {
  principal: Principal;
  /**
   * Fixed request id (HTTP, where one server handles one request). When
   * omitted, each tool call gets a fresh id (stdio, where a server lives for
   * the whole process).
   */
  requestId?: string;
}

export type ServerFactory = (session: SessionContext) => McpServer;

/**
 * Builds a factory that creates an `McpServer` bound to one principal.
 *
 * Binding per principal means `tools/list` only advertises tools the caller is
 * allowed to use, and handlers never see another caller's identity. Scope is
 * still re-checked on every call.
 */
export function createServerFactory(options: McpKitOptions): ServerFactory {
  const logger = options.logger ?? createLogger();
  const audit: AuditHook = options.audit ?? ((event) => logger.info("audit", { audit: event }));

  const byName = new Map<string, Tool>();
  for (const tool of options.tools) {
    if (byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    byName.set(tool.name, tool);
  }

  return (session) => {
    const server = new McpServer(
      { name: options.name, version: options.version },
      {
        capabilities: { tools: {} },
        ...(options.instructions ? { instructions: options.instructions } : {}),
      },
    );

    server.server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: [...byName.values()]
        .filter((tool) => hasScope(session.principal, tool.scope))
        .map((tool): McpToolDescriptor => {
          const descriptor: McpToolDescriptor = {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputJsonSchema,
          };
          if (tool.title) descriptor.title = tool.title;
          if (tool.annotations) descriptor.annotations = tool.annotations;
          return descriptor;
        }),
    }));

    server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = byName.get(request.params.name);
      if (!tool) {
        throw new McpError(ErrorCode.InvalidParams, `unknown tool: ${request.params.name}`);
      }
      return invokeTool(tool, request.params.arguments, {
        principal: session.principal,
        requestId: session.requestId ?? randomUUID(),
        logger,
        signal: extra.signal,
        audit,
      });
    });

    options.setup?.(server);
    return server;
  };
}
