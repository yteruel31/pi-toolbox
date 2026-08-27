import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { Type } from "typebox";

import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import { SessionIndexService } from "../runtime/services.js";
import type { SessionIndex } from "./index.js";
import { readSession } from "./reader.js";

const MAX_TEXT_BYTES = 50 * 1024;
const TRUNCATION_MARKER = "\n… (truncated)";

export function truncateToolText(text: string, maxBytes = MAX_TEXT_BYTES): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const budget = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  const codepoints = Array.from(text);
  let low = 0;
  let high = codepoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(codepoints.slice(0, middle).join(""), "utf8") <= budget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${codepoints.slice(0, low).join("")}${TRUNCATION_MARKER}`;
}

function result(text: string, details: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: truncateToolText(text) }],
    details,
  };
}

function integer(
  value: unknown,
  fallback: number,
  max: number,
  allowZero = false
): number | undefined {
  if (value === undefined) return fallback;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= (allowZero ? 0 : 1) &&
    value <= max
    ? value
    : undefined;
}

function validDate(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length <= 40 &&
      !Number.isNaN(Date.parse(value)))
  );
}

async function withIndex<A>(
  controller: ContextRuntimeController,
  fn: (index: SessionIndex) => A
): Promise<A> {
  const handle = controller.currentHandle;
  if (!handle) {
    throw new Error("Session index is not ready; wait for session startup and retry.");
  }
  return handle.run(Effect.map(SessionIndexService, fn));
}

function display(session: any): string {
  return `${session.id} | ${session.createdAt.slice(0, 10)}${
    session.archived ? " | archived" : ""
  }\n${session.title || "(untitled)"}\nProject: ${session.project} | CWD: ${session.cwd}`;
}

export function registerSessionTools(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Search past Pi sessions using local FTS5/BM25.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      project: Type.Optional(Type.String({ maxLength: 500 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
    }),
    async execute(_id, params) {
      const limit = integer(params.limit, 10, 25);
      if (!limit) {
        return result("Invalid limit: expected an integer from 1 to 25.", {
          ok: false,
          field: "limit",
        });
      }
      return withIndex(controller, (index) => {
        const found = index.search(params.query, limit, params.project);
        if (found.status === "unavailable") {
          return result(
            `Session search unavailable: ${found.diagnostic}. Use a Node/SQLite build with FTS5, then run /session-reindex.`,
            { ok: false, capability: "fts5" }
          );
        }
        return result(
          found.results
            .map((session) => `${display(session)}\nRank: ${session.rank}`)
            .join("\n\n") || "No relevant sessions found.",
          {
            ok: true,
            query: params.query,
            project: params.project,
            limit,
            resultCount: found.results.length,
            results: found.results.map((session) => ({
              id: session.id,
              rank: session.rank,
              project: session.project,
              createdAt: session.createdAt,
              archived: session.archived,
            })),
          }
        );
      });
    },
  });

  pi.registerTool({
    name: "session_list",
    label: "Session List",
    description:
      "List past Pi sessions by project, date range, or archive status.",
    parameters: Type.Object({
      project: Type.Optional(Type.String({ maxLength: 500 })),
      after: Type.Optional(Type.String({ maxLength: 40 })),
      before: Type.Optional(Type.String({ maxLength: 40 })),
      archived: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_id, params) {
      const limit = integer(params.limit, 20, 50);
      if (
        !limit ||
        !validDate(params.after) ||
        !validDate(params.before) ||
        (params.after &&
          params.before &&
          Date.parse(params.after) > Date.parse(params.before))
      ) {
        return result(
          "Invalid date range or limit (limit must be 1..50; dates must be ISO-compatible and ordered).",
          { ok: false, field: "filters" }
        );
      }
      return withIndex(controller, (index) => {
        const rows = index.list({ ...params, limit });
        return result(
          rows.map(display).join("\n\n") || "No sessions match the filters.",
          {
            ok: true,
            resultCount: rows.length,
            limit,
            sessions: rows.map((session) => ({
              id: session.id,
              project: session.project,
              createdAt: session.createdAt,
              archived: session.archived,
            })),
          }
        );
      });
    },
  });

  pi.registerTool({
    name: "session_read",
    label: "Session Read",
    description:
      "Read a managed past Pi session by ID/prefix or explicit session path, with pagination.",
    parameters: Type.Object({
      session: Type.String({ minLength: 1, maxLength: 4096 }),
      offset: Type.Optional(Type.Integer({ minimum: 0 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      include_tools: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      const offset = integer(
        params.offset,
        0,
        Number.MAX_SAFE_INTEGER,
        true
      );
      const limit = integer(params.limit, 50, 100);
      if (offset === undefined || limit === undefined) {
        return result(
          "Invalid pagination: offset must be non-negative and limit must be 1..100.",
          { ok: false, field: "pagination" }
        );
      }
      const read = await withIndex(controller, (index) =>
        readSession(index, params.session, {
          offset,
          limit,
          includeTools: params.include_tools ?? false,
        })
      );
      return result(read.text, read.details as Record<string, unknown>);
    },
  });
}
