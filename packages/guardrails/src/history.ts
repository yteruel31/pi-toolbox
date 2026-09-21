import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { isSupportedTool, isTool, type Candidate, type HistoryEntry } from "./types.js";
import { sanitize, sanitizePath } from "./sanitize.js";

const s = (max: number) => z.string().max(max).transform((v) => sanitize(v, max));
const pathText = z.string().max(4096).transform((v) => sanitizePath(v));
const entrySchema = z.object({
  id: z.uuid(), at: z.number(), updatedAt: z.number(),
  sessionId: s(200), project: pathText, cwd: pathText, callId: s(200), leafId: s(100).optional(),
  actor: z.discriminatedUnion("kind", [z.object({ kind: z.literal("main") }), z.object({ kind: z.literal("subagent"), runId: s(100), profile: s(100).optional(), childSessionId: s(100).optional() })]),
  tool: z.custom<HistoryEntry["tool"]>((v) => typeof v === "string" && isSupportedTool(v)), summary: z.string().max(4000), target: z.string().max(4096), operation: s(100),
  action: z.enum(["Allow", "Ask", "Deny"]), origin: z.enum(["policy", "model", "error", "rule-only-no-match", "bypass"]), reason: s(2000),
  policyIds: z.array(s(100)).max(200), historyIds: z.array(z.uuid()).max(16),
  model: z.object({ route: s(200), thinking: s(20), durationMs: z.number().nonnegative() }).optional(),
  jev: z.object({
    probabilities: z.object({ Allow: z.number().min(0).max(1), Ask: z.number().min(0).max(1), Deny: z.number().min(0).max(1) }).strict(),
    restrictions: z.array(z.tuple([s(100), z.number().min(0).max(1)])).max(200),
    thresholds: z.object({ allow: z.number().min(0).max(1), deny: z.number().min(0).max(1), restrictive: z.number().min(0).max(1) }).strict(),
    reasons: z.array(z.enum(["generic-allow", "generic-deny", "restrictive-policy", "generic-uncertain", "incomplete-input", "redacted-input"])).max(6),
  }).strict().optional(),
  choice: z.enum(["allow-once", "deny", "deny-stop"]).optional(),
  state: z.enum(["assessing", "review", "allowed", "denied"]),
  execution: z.enum(["not-observed", "blocked", "reported-success", "reported-error"]),
}).transform((entry) => ({ ...entry,
  target: isTool(entry.tool) ? sanitizePath(entry.target) : sanitize(entry.target, 4096),
  summary: ["read", "write", "edit"].includes(entry.tool) ? sanitizePath(entry.summary, 4000) : sanitize(entry.summary, 4000),
}));
export const HISTORY_LIMIT = 2000;
export const HISTORY_DAYS = 30;
export class HistoryStore {
  private db: DatabaseSync;
  private closed = false;
  private listeners = new Set<() => void>();
  constructor(path: string, private limit = HISTORY_LIMIT, private now: () => number = Date.now) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (lstatSync(dirname(path)).isSymbolicLink()) throw new Error("History directory must not be a symlink");
      chmodSync(dirname(path), 0o700);
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Unsafe history file");
        chmodSync(path, 0o600);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    }
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    try {
      this.db.exec(`PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at REAL NOT NULL, payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS events_at ON events(at);`);
      this.prune();
    } catch (e) { this.db.close(); throw e; }
  }
  private prune(): void {
    this.db.prepare("DELETE FROM events WHERE at < ?").run(this.now() - HISTORY_DAYS * 86400000);
    this.db.prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY at DESC, id DESC LIMIT ?)").run(this.limit);
  }
  put(entry: HistoryEntry): HistoryEntry {
    if (this.closed) throw new Error("History is closed");
    const safe = entrySchema.parse(entry);
    const payload = JSON.stringify(safe);
    if (Buffer.byteLength(payload) > 24000) throw new Error("History entry too large");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO events(id, at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(safe.id, safe.at, payload);
      this.prune(); this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    for (const listener of this.listeners) { try { listener(); } catch { /* A view cannot affect a decision. */ } }
    return safe;
  }
  list(): HistoryEntry[] {
    if (this.closed) return [];
    const rows = this.db.prepare("SELECT payload FROM events WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?").all(this.now() - HISTORY_DAYS * 86400000, this.limit);
    return rows.flatMap((row) => {
      try {
        if (typeof row.payload !== "string" || Buffer.byteLength(row.payload) > 24000) return [];
        return [entrySchema.parse(JSON.parse(row.payload))];
      } catch { return []; } // Local records aren't trusted model instructions.
    });
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close(): void { if (!this.closed) { this.closed = true; this.listeners.clear(); this.db.close(); } }
}
export interface HistoryFilter { sessionId?: string; search?: string; actor?: "main" | "subagent"; decision?: "auto" | "human" | "attention" | "denied" }
export function decisionCategory(e: HistoryEntry): NonNullable<HistoryFilter["decision"]> {
  if (e.state === "denied") return "denied";
  if (e.state === "review" || e.state === "assessing") return "attention";
  return e.choice === "allow-once" ? "human" : "auto";
}
export function filterHistory(entries: HistoryEntry[], filter: HistoryFilter): HistoryEntry[] {
  const query = filter.search?.toLowerCase() ?? "";
  return entries.filter((e) => (!filter.sessionId || e.sessionId === filter.sessionId)
    && (!filter.actor || e.actor.kind === filter.actor)
    && (!filter.decision || decisionCategory(e) === filter.decision)
    && (!query || [e.summary, e.reason, e.tool, e.target, e.operation, e.project, e.sessionId, e.actor.kind === "subagent" ? `${e.actor.profile ?? ""} ${e.actor.runId}` : "Main"].join(" ").toLowerCase().includes(query)));
}
export function relevantHistory(entries: HistoryEntry[], c: Candidate, target: string, operation: string, policyIds: string[]): HistoryEntry[] {
  const sameProject = entries.filter((e) => e.project === c.project && e.callId !== c.callId && e.state !== "assessing" && e.state !== "review");
  const recent = sameProject.filter((e) => e.sessionId === c.sessionId).slice(0, 6);
  const pertinent = sameProject.filter((e) => e.target === target || e.operation === operation || e.policyIds.some((id) => policyIds.includes(id))).slice(0, 10);
  const result: HistoryEntry[] = [];
  let bytes = 0;
  for (const entry of [...recent, ...pertinent]) {
    if (result.some((e) => e.id === entry.id)) continue;
    bytes += Buffer.byteLength(JSON.stringify(entry));
    if (bytes > 16000) break;
    result.push(entry);
  }
  return result;
}
