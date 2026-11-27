import { z } from "zod";
import { isValidScope } from "./auth/tokens.js";

const csv = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const envSchema = z.object({
  HOST: z.string().min(1).default("127.0.0.1"),
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  MCP_PATH: z.string().startsWith("/").default("/mcp"),
  TOKENS_FILE: z.string().min(1).default("./data/tokens.json"),
  RATE_LIMIT_CAPACITY: z.coerce.number().positive().default(60),
  RATE_LIMIT_REFILL_PER_SEC: z.coerce.number().positive().default(1),
  RATE_LIMIT_DISABLED: z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1"),
  ALLOWED_ORIGINS: z.string().optional().transform(csv),
  MAX_BODY_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  STDIO_SCOPES: z
    .string()
    .default("read,write")
    .transform(csv)
    .refine((scopes) => scopes.length > 0 && scopes.every(isValidScope), "must be a comma-separated scope list"),
});

export type Config = z.output<typeof envSchema>;

/** Parses configuration from environment variables, failing fast with a readable message. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n${lines.join("\n")}`);
  }
  return parsed.data;
}
