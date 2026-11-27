import { z } from "zod";
// In your own project: import { defineTool, ToolError } from "mcp-kit";
import { ToolError, defineTool, type Tool } from "../../src/index.js";
import type { NotesStore } from "./notes-store.js";

const noteId = z.uuid().describe("Note id, as returned by create_note or list_notes");
const tag = z
  .string()
  .regex(/^[a-z0-9-]{1,32}$/, "tags are lowercase letters, digits and dashes, max 32 chars");

export function notesTools(store: NotesStore): Tool[] {
  return [
    defineTool({
      name: "list_notes",
      title: "List notes",
      description: "List notes, newest first. Optionally filter by a text query or a tag.",
      scope: "read",
      annotations: { readOnlyHint: true },
      input: z.object({
        query: z.string().max(200).optional().describe("Case-insensitive substring match on title and body"),
        tag: tag.optional(),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      handler: (input) => {
        const notes = store.list(input);
        return { count: notes.length, notes };
      },
    }),

    defineTool({
      name: "get_note",
      title: "Get note",
      description: "Fetch a single note by id.",
      scope: "read",
      annotations: { readOnlyHint: true },
      input: z.object({ id: noteId }),
      handler: ({ id }) => {
        const note = store.get(id);
        if (!note) throw new ToolError("not_found", `no note with id ${id}`);
        return note;
      },
    }),

    defineTool({
      name: "create_note",
      title: "Create note",
      description: "Create a note. Returns the stored note including its id.",
      scope: "write",
      input: z.object({
        title: z.string().trim().min(1).max(200),
        body: z.string().max(10_000).default(""),
        tags: z.array(tag).max(10).default([]),
      }),
      handler: (input, ctx) => {
        const note = store.create({ ...input, createdBy: ctx.principal.name });
        ctx.logger.info("note created", { noteId: note.id });
        return note;
      },
    }),

    defineTool({
      name: "delete_note",
      title: "Delete note",
      description: "Permanently delete a note by id.",
      scope: "write",
      annotations: { destructiveHint: true, idempotentHint: true },
      input: z.object({ id: noteId }),
      handler: ({ id }) => {
        if (!store.delete(id)) throw new ToolError("not_found", `no note with id ${id}`);
        return { deleted: id };
      },
    }),
  ];
}
