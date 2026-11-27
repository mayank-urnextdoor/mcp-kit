/**
 * Token management CLI.
 *
 *   tokens mint --name <label> [--scopes read,write] [--expires-in-days N] [--file path]
 *   tokens list [--file path]
 *   tokens revoke <id> [--file path]
 *
 * The plaintext token is printed exactly once, on stdout, so it can be piped
 * into a secret manager. Everything else goes to stderr.
 */
import { parseArgs } from "node:util";
import { FileTokenStore, mintToken } from "../src/index.js";

const USAGE = `usage:
  tokens mint --name <label> [--scopes read,write] [--expires-in-days N] [--file path]
  tokens list [--file path]
  tokens revoke <id> [--file path]

--file defaults to $TOKENS_FILE, then ./data/tokens.json`;

function fail(message: string, showUsage = true): never {
  console.error(showUsage ? `error: ${message}\n\n${USAGE}` : `error: ${message}`);
  process.exit(showUsage ? 2 : 1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      scopes: { type: "string", default: "read" },
      "expires-in-days": { type: "string" },
      file: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.error(USAGE);
    return;
  }

  const [command, ...rest] = positionals;
  const store = new FileTokenStore(values.file ?? process.env.TOKENS_FILE ?? "./data/tokens.json");

  switch (command) {
    case "mint": {
      if (!values.name) fail("--name is required");
      let ttlMs: number | undefined;
      if (values["expires-in-days"] !== undefined) {
        const days = Number(values["expires-in-days"]);
        if (!Number.isFinite(days) || days <= 0) fail("--expires-in-days must be a positive number");
        ttlMs = days * 24 * 60 * 60 * 1000;
      }
      const scopes = values.scopes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const { token, record } = mintToken({ name: values.name, scopes, ttlMs });
      await store.add(record);
      console.error(
        `minted token ${record.id} (${record.name}) scopes=[${record.scopes.join(",")}]` +
          (record.expiresAt ? ` expires=${record.expiresAt}` : "") +
          `\nstored hash in ${store.path}. The token below is shown once; store it now.`,
      );
      process.stdout.write(token + "\n");
      return;
    }
    case "list": {
      const records = await store.list();
      if (records.length === 0) {
        console.error(`no tokens in ${store.path}`);
        return;
      }
      for (const r of records) {
        process.stdout.write(
          [r.id, r.name, r.scopes.join(","), r.createdAt, r.expiresAt ?? "never"].join("\t") + "\n",
        );
      }
      return;
    }
    case "revoke": {
      const id = rest[0];
      if (!id) fail("revoke needs a token id");
      if (!(await store.remove(id))) fail(`no token with id ${id} in ${store.path}`, false);
      console.error(`revoked ${id}`);
      return;
    }
    default:
      fail(command ? `unknown command: ${command}` : "missing command");
  }
}

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
