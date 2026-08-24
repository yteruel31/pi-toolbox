import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";
import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import { KnowledgeIndexService } from "../runtime/services.js";
import type { KnowledgeIndex } from "./index.js";
import {
  DEFAULT_NOTE_BYTES,
  MAX_NOTE_BYTES,
  readIndexedNote,
  resolveIndexedNote,
} from "./reader.js";

const MAX_TEXT_BYTES = 50 * 1024;
const MAX_EXCERPT_BYTES = 2 * 1024;
const truncate = (text: string, bytes: number) => {
  if (Buffer.byteLength(text) <= bytes) return text;
  let result = "";
  for (const point of text) {
    if (Buffer.byteLength(result + point + "\n… (truncated)") > bytes) break;
    result += point;
  }
  return `${result}\n… (truncated)`;
};
const response = (text: string, details: Record<string, unknown>) => ({
  content: [{ type: "text" as const, text: truncate(text, MAX_TEXT_BYTES) }],
  details,
});
async function withIndex<A>(
  controller: ContextRuntimeController,
  fn: (index: KnowledgeIndex) => A | Promise<A>
): Promise<A> {
  const handle = controller.currentHandle;
  if (!handle)
    throw new Error(
      "Knowledge index is not ready; wait for session startup and retry."
    );
  return handle.run(
    Effect.flatMap(KnowledgeIndexService, (index) =>
      Effect.promise(() => Promise.resolve(fn(index)))
    )
  );
}

export function registerKnowledgeTools(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  pi.registerTool({
    name: "knowledge_search",
    label: "Knowledge Search",
    description: "Search indexed local knowledge with SQLite FTS5/BM25.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_id, params) {
      const limit = params.limit ?? 8;
      if (!Number.isInteger(limit) || limit < 1 || limit > 20)
        return response("Invalid limit: expected an integer from 1 to 20.", {
          ok: false,
          field: "limit",
        });
      return withIndex(controller, (index) => {
        const found = index.search(params.query, limit);
        if (found.status === "unavailable")
          return response(
            `Knowledge search unavailable: ${found.diagnostic}. Use a Node/SQLite build with FTS5, then run /knowledge-reindex.`,
            { ok: false, capability: "fts5" }
          );
        const hits = found.results.map((hit) => ({
          path: hit.path,
          heading: hit.heading,
          rank: hit.rank,
          excerpt: truncate(
            hit.text.replace(/\s+/g, " ").trim(),
            MAX_EXCERPT_BYTES
          ),
        }));
        return response(
          hits
            .map(
              (hit, i) =>
                `### ${i + 1}. ${hit.path}${
                  hit.heading === "intro" ? "" : ` > ${hit.heading}`
                }\nRank: ${hit.rank}\n\n${hit.excerpt}`
            )
            .join("\n\n---\n\n") ||
            `No relevant results found for: "${params.query}"`,
          {
            ok: true,
            query: params.query,
            limit,
            resultCount: hits.length,
            results: hits,
          }
        );
      });
    },
  });
  pi.registerTool({
    name: "kb_read",
    label: "KB Read",
    description:
      "Safely read an indexed note by relative path, unique basename, or [[wikilink]].",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: 4096 }),
      max_bytes: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_NOTE_BYTES })
      ),
    }),
    async execute(_id, params) {
      const maximum = params.max_bytes ?? DEFAULT_NOTE_BYTES;
      if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_NOTE_BYTES)
        return response(
          `Invalid max_bytes: expected an integer from 1 to ${MAX_NOTE_BYTES}.`,
          { ok: false, field: "max_bytes" }
        );
      return withIndex(controller, async (index) => {
        const resolved = resolveIndexedNote(index, params.name);
        if (resolved.status === "not-found")
          return response(
            `No indexed note matched "${params.name}". Try knowledge_search with a topic query.`,
            { ok: false, reason: "not-indexed" }
          );
        if (resolved.status === "ambiguous")
          return response(
            `"${params.name}" is ambiguous. Candidates:\n${resolved.candidates
              .map((item) => `- ${item}`)
              .join("\n")}\nUse an exact relative path.`,
            { ok: false, reason: "ambiguous", candidates: resolved.candidates }
          );
        try {
          const note = await readIndexedNote(resolved.file, maximum);
          return response(
            `# ${resolved.file.relativePath}${
              note.truncated ? "\n_(truncated)_" : ""
            }\n\n${note.content}`,
            {
              ok: true,
              path: note.path,
              truncated: note.truncated,
              totalBytes: note.totalBytes,
            }
          );
        } catch (error) {
          return response(
            `Indexed note could not be read safely: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { ok: false, reason: "unsafe-or-unreadable" }
          );
        }
      });
    },
  });
}
