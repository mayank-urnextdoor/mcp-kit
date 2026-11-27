import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { TokenRecord, TokenStore } from "./tokens.js";

const recordSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  name: z.string().min(1),
  scopes: z.array(z.string()).min(1),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  expiresAt: z.string().optional(),
});

const fileSchema = z.object({
  version: z.literal(1),
  tokens: z.array(recordSchema),
});

const copy = (r: TokenRecord): TokenRecord => ({ ...r, scopes: [...r.scopes] });

/**
 * Token store backed by a JSON file of hashed tokens.
 *
 * The file is re-read when its mtime changes, so tokens minted or revoked with
 * the CLI take effect without a restart. Writes go to a temp file that is
 * renamed into place, so a crash never leaves a half-written store.
 *
 * Suitable for a single instance. For multiple replicas, implement
 * `TokenStore` over a shared database instead.
 */
export class FileTokenStore implements TokenStore {
  private cache = new Map<string, TokenRecord>();
  private loadedMtimeMs = -1;

  constructor(readonly path: string) {}

  private async refresh(): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(this.path)).mtimeMs;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = new Map();
        this.loadedMtimeMs = -1;
        return;
      }
      throw err;
    }
    if (mtimeMs === this.loadedMtimeMs) return;

    const raw = await readFile(this.path, "utf8");
    const parsed = fileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`token store ${this.path} is invalid: ${parsed.error.message}`);
    }
    this.cache = new Map(parsed.data.tokens.map((t) => [t.id, t]));
    this.loadedMtimeMs = mtimeMs;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const body = JSON.stringify({ version: 1, tokens: [...this.cache.values()] }, null, 2) + "\n";
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, this.path);
    this.loadedMtimeMs = (await stat(this.path)).mtimeMs;
  }

  async findById(id: string): Promise<TokenRecord | undefined> {
    await this.refresh();
    const r = this.cache.get(id);
    return r ? copy(r) : undefined;
  }

  async add(record: TokenRecord): Promise<void> {
    await this.refresh();
    if (this.cache.has(record.id)) throw new Error(`token id already exists: ${record.id}`);
    this.cache.set(record.id, recordSchema.parse(record));
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    await this.refresh();
    const existed = this.cache.delete(id);
    if (existed) await this.persist();
    return existed;
  }

  async list(): Promise<TokenRecord[]> {
    await this.refresh();
    return [...this.cache.values()].map(copy);
  }
}
