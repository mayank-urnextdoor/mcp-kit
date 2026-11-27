import {
  FileTokenStore,
  RateLimiter,
  createLogger,
  createServerFactory,
  loadConfig,
  localPrincipal,
  runStdio,
  startHttpServer,
} from "../../src/index.js";
import { NotesStore } from "./notes-store.js";
import { notesTools } from "./tools.js";

const useStdio = process.argv.includes("--stdio");

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.LOG_LEVEL, bindings: { service: "notes-server" } });

  const factory = createServerFactory({
    name: "mcp-kit-notes",
    version: "0.1.0",
    instructions: "A small notes service. Use list_notes to find ids before calling get_note or delete_note.",
    tools: notesTools(new NotesStore()),
    logger,
  });

  if (useStdio) {
    await runStdio(factory, localPrincipal(config.STDIO_SCOPES));
    logger.info("serving MCP over stdio", { scopes: config.STDIO_SCOPES });
    return;
  }

  const tokenStore = new FileTokenStore(config.TOKENS_FILE);
  if ((await tokenStore.list()).length === 0) {
    logger.warn("token store is empty: every request will get 401 until you mint a token with the tokens CLI", {
      tokensFile: config.TOKENS_FILE,
    });
  }

  const running = await startHttpServer({
    factory,
    tokenStore,
    rateLimiter: config.RATE_LIMIT_DISABLED
      ? undefined
      : new RateLimiter({ capacity: config.RATE_LIMIT_CAPACITY, refillPerSecond: config.RATE_LIMIT_REFILL_PER_SEC }),
    logger,
    host: config.HOST,
    port: config.PORT,
    path: config.MCP_PATH,
    allowedOrigins: config.ALLOWED_ORIGINS,
    maxBodyBytes: config.MAX_BODY_BYTES,
  });
  logger.info("serving MCP over HTTP", { url: running.url, tokensFile: config.TOKENS_FILE });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    running.close().then(
      () => process.exit(0),
      (err: unknown) => {
        logger.error("error during shutdown", { err });
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  if ((err as NodeJS.ErrnoException | undefined)?.code === "EADDRINUSE") {
    console.error("Another process is using that port. Stop it, or set PORT to a free port (PORT=0 picks one).");
  }
  process.exit(1);
});
