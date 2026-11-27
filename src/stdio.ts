import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Principal } from "./auth/tokens.js";
import type { ServerFactory } from "./server.js";

/**
 * Serves MCP over stdin/stdout for a locally spawned client.
 *
 * There is no bearer token on stdio: whoever can spawn the process already
 * has the user's privileges. The `principal` decides which scopes the local
 * session gets, so you can still run a read-only local server.
 */
export async function runStdio(factory: ServerFactory, principal: Principal): Promise<McpServer> {
  const server = factory({ principal });
  await server.connect(new StdioServerTransport());
  return server;
}

export function localPrincipal(scopes: readonly string[]): Principal {
  return { tokenId: "stdio", name: "local-stdio", scopes: [...scopes] };
}
