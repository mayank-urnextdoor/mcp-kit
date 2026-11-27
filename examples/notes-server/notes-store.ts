import { randomUUID } from "node:crypto";

export interface Note {
  id: string;
  title: string;
  body: string;
  tags: string[];
  createdBy: string;
  createdAt: string;
}

export interface NewNote {
  title: string;
  body: string;
  tags: string[];
  createdBy: string;
}

/** Deliberately simple in-memory store. Replace with a database in a real server. */
export class NotesStore {
  private readonly notes = new Map<string, Note>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  create(input: NewNote): Note {
    const note: Note = { id: randomUUID(), ...input, tags: [...input.tags], createdAt: this.now().toISOString() };
    this.notes.set(note.id, note);
    return note;
  }

  get(id: string): Note | undefined {
    return this.notes.get(id);
  }

  list(filter: { query?: string; tag?: string; limit: number }): Note[] {
    const q = filter.query?.toLowerCase();
    return [...this.notes.values()]
      .filter((n) => (filter.tag ? n.tags.includes(filter.tag) : true))
      .filter((n) => (q ? n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q) : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit);
  }

  delete(id: string): boolean {
    return this.notes.delete(id);
  }
}
