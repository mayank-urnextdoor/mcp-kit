import type { TokenRecord, TokenStore } from "./tokens.js";

const copy = (r: TokenRecord): TokenRecord => ({ ...r, scopes: [...r.scopes] });

/** Process-local token store. Useful for tests and for embedding mcp-kit. */
export class InMemoryTokenStore implements TokenStore {
  private readonly records = new Map<string, TokenRecord>();

  constructor(records: TokenRecord[] = []) {
    for (const r of records) this.records.set(r.id, copy(r));
  }

  async findById(id: string): Promise<TokenRecord | undefined> {
    const r = this.records.get(id);
    return r ? copy(r) : undefined;
  }

  async add(record: TokenRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error(`token id already exists: ${record.id}`);
    this.records.set(record.id, copy(record));
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async list(): Promise<TokenRecord[]> {
    return [...this.records.values()].map(copy);
  }
}
