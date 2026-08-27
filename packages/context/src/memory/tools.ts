import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Effect } from "effect";
import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import { MemoryStoreService } from "../runtime/services.js";
import { canonicalProject } from "./injector.js";

const MAX_OUTPUT = 12_000;
function unwrap<T>(value: T): T {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text.length < 2) return value;
  const quoted =
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"));
  if (!quoted) return value;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text.slice(1, -1) as T;
  }
}
function prepare(args: unknown): any {
  if (!args || typeof args !== "object") return args;
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [key, unwrap(value)])
  );
}
const result = (text: string, details: Record<string, unknown>) => ({
  content: [
    {
      type: "text" as const,
      text:
        text.length > MAX_OUTPUT
          ? `${text.slice(0, MAX_OUTPUT - 20)}\n… (truncated)`
          : text,
    },
  ],
  details: { ...details, truncated: text.length > MAX_OUTPUT },
});
const limit = (value: unknown, fallback: number, max: number) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 1 &&
  value <= max
    ? value
    : fallback;
async function storeRun<A>(
  controller: ContextRuntimeController,
  fn: (store: any) => A
): Promise<A> {
  const h = controller.currentHandle;
  if (!h) throw new Error("Memory store not initialized");
  return h.run(Effect.map(MemoryStoreService, fn));
}
export function registerMemoryTools(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent facts and applicable lessons.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    prepareArguments: prepare,
    async execute(_id, p, _s, _u, ctx) {
      const n = limit(p.limit, 10, 50),
        project = canonicalProject(ctx.cwd);
      return storeRun(controller, (s) => {
        const facts = s.searchFacts(p.query, n),
          lessons = s.searchLessons(p.query, n, project);
        return result(
          [
            ...facts.map(
              (x: any) =>
                `${x.key}: ${x.value} (confidence: ${x.confidence}, source: ${x.source})`
            ),
            ...lessons.map(
              (x: any) =>
                `${x.negative ? "AVOID: " : ""}${x.rule} [${x.category}] (id: ${
                  x.id
                })`
            ),
          ].join("\n") || "No matching memories found.",
          { query: p.query, limit: n, facts, lessons, project }
        );
      });
    },
  });
  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a durable fact or lesson.",
    executionMode: "sequential",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("fact"), Type.Literal("lesson")]),
      key: Type.Optional(Type.String({ maxLength: 100 })),
      value: Type.Optional(Type.String({ maxLength: 500 })),
      rule: Type.Optional(Type.String({ maxLength: 500 })),
      category: Type.Optional(Type.String({ maxLength: 80 })),
      negative: Type.Optional(Type.Boolean()),
    }),
    prepareArguments: prepare,
    async execute(_id, p) {
      p = prepare(p);
      return storeRun(controller, (s) => {
        if (p.type === "fact") {
          if (!p.key?.trim() || !p.value?.trim())
            return result("Both key and value required for facts", {
              ok: false,
              type: p.type,
            });
          const changed = s.setFact(p.key, p.value, 0.95, "user");
          return result(`Remembered: ${p.key} = ${p.value}`, {
            ok: true,
            type: p.type,
            key: p.key,
            changed,
          });
        }
        if (!p.rule?.trim())
          return result("Rule text required for lessons", {
            ok: false,
            type: p.type,
          });
        const added = s.addLesson({
          rule: p.rule,
          category: p.category,
          negative: p.negative,
          confidence: 0.95,
          source: "user",
          project: null,
        });
        return result(
          added.success
            ? `Lesson learned: ${p.rule}`
            : `Already known (${added.reason}): ${p.rule}`,
          { ok: added.success, type: p.type, ...added }
        );
      });
    },
  });
  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove a fact or soft-delete a lesson.",
    executionMode: "sequential",
    parameters: Type.Object({
      type: Type.Union([Type.Literal("fact"), Type.Literal("lesson")]),
      key: Type.Optional(Type.String({ maxLength: 100 })),
      id: Type.Optional(Type.String({ maxLength: 36 })),
    }),
    prepareArguments: prepare,
    async execute(_id, p) {
      p = prepare(p);
      return storeRun(controller, (s) => {
        if (p.type === "fact") {
          if (!p.key)
            return result("Provide key for facts", { ok: false, type: p.type });
          const deleted = s.deleteFact(p.key);
          return result(deleted ? `Forgot: ${p.key}` : `Not found: ${p.key}`, {
            ok: deleted,
            type: p.type,
            key: p.key,
          });
        }
        if (!p.id)
          return result("Provide id for lessons", { ok: false, type: p.type });
        const deleted = s.deleteLesson(p.id);
        return result(
          deleted ? `Forgot lesson ${p.id}` : `Not found: ${p.id}`,
          { ok: deleted, type: p.type, id: p.id }
        );
      });
    },
  });
  pi.registerTool({
    name: "memory_lessons",
    label: "Memory Lessons",
    description: "List learned corrections and approaches.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ maxLength: 80 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    prepareArguments: prepare,
    async execute(_id, p, _s, _u, ctx) {
      const n = limit(p.limit, 50, 100);
      return storeRun(controller, (s) => {
        const lessons = s.listLessons(p.category, n, canonicalProject(ctx.cwd));
        return result(
          lessons
            .map(
              (x: any) =>
                `${x.negative ? "❌" : "✅"} [${x.category}] ${x.rule} (id: ${
                  x.id
                })`
            )
            .join("\n") || "No lessons learned yet.",
          {
            category: p.category,
            limit: n,
            lessons,
            project: canonicalProject(ctx.cwd),
          }
        );
      });
    },
  });
  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show persistent memory statistics.",
    parameters: Type.Object({}),
    async execute() {
      return storeRun(controller, (s) => {
        const stats = s.stats();
        return result(
          `Memory: ${stats.facts} facts, ${stats.lessons} active lessons, ${stats.pendingEvents} pending events`,
          stats
        );
      });
    },
  });
}
