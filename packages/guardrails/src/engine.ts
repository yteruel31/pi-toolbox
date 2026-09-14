import { randomUUID } from "node:crypto";
import { bypasses, type ConfigSnapshot } from "./config.js";
import type { Block, Candidate, Decision, HistoryEntry } from "./types.js";
import type { CompletionBridge } from "./judge.js";
import { bounded, judge } from "./judge.js";
import { HistoryStore, relevantHistory } from "./history.js";
import { evaluatePolicies } from "./policies.js";
import { candidateView, sanitize, sanitizePath } from "./sanitize.js";

function ruleOnlyAllow(): Decision {
  return { action: "Allow", origin: "rule-only-no-match", reason: "Judge model is off. No deterministic rule matched; rule-only mode allows unmatched calls.", policyIds: [], historyIds: [] };
}

export type Approval = (entry: HistoryEntry, signal: AbortSignal) => Promise<"allow-once" | "deny" | "deny-stop">;
export interface EngineOptions {
  load: () => Promise<ConfigSnapshot>;
  bridge: CompletionBridge;
  history: HistoryStore;
  protectedPaths: string[];
  signal: AbortSignal;
}
export class GuardrailsEngine {
  private calls = new Map<string, HistoryEntry>();
  constructor(private options: EngineOptions) {}
  private key(c: Pick<Candidate, "callId" | "sessionId" | "actor">): string {
    return JSON.stringify([c.sessionId, c.actor.kind === "subagent" ? [c.actor.runId, c.actor.childSessionId] : "main", c.callId]);
  }
  async evaluate(c: Candidate, signal?: AbortSignal): Promise<{ decision: Decision; target: string; operation: string; enabled: boolean }> {
    const snapshot = await this.options.load();
    if (bypasses(snapshot, c.tool)) return { target: "", operation: "", enabled: false, decision: { action: "Allow", origin: "bypass", reason: "Protection or module is off. No assessment performed.", policyIds: [], historyIds: [] } };
    const evaluated = this.describe(c, snapshot);
    if (evaluated.decision) return { ...evaluated, enabled: true, decision: evaluated.decision };
    if (!snapshot.config.judgeEnabled) return { ...evaluated, enabled: true, decision: ruleOnlyAllow() };
    const history = relevantHistory(this.options.history.list(), c, evaluated.target, evaluated.operation, evaluated.natural.map((p) => p.id));
    const decision = await judge(this.options.bridge, snapshot.config, c, evaluated.natural, history, evaluated.target, evaluated.operation, signal);
    return { ...evaluated, enabled: true, decision };
  }
  private describe(c: Candidate, snapshot: ConfigSnapshot): ReturnType<typeof evaluatePolicies> {
    const evaluated = evaluatePolicies(c, snapshot.error ? [] : snapshot.policies, this.options.protectedPaths, snapshot.config.judgeEnabled);
    if (snapshot.error && evaluated.decision?.action !== "Deny") evaluated.decision = this.configError(snapshot);
    return evaluated;
  }
  private configError(snapshot: ConfigSnapshot): Decision {
    return { action: snapshot.config.errorBehavior === "deny" ? "Deny" : "Ask", origin: "error", reason: snapshot.error!, policyIds: [], historyIds: [] };
  }
  /** Dry runs call evaluate directly: no execution, approval UI or history mutation. */
  async assess(c: Candidate, approval?: Approval, signal?: AbortSignal): Promise<Block | undefined> {
    const combined = AbortSignal.any([this.options.signal, ...(signal ? [signal] : [])]);
    if (combined.aborted) return { block: true, reason: "Guardrails session or run has ended." };
    let entry: HistoryEntry | undefined;
    try {
      const snapshot = await this.options.load();
      if (bypasses(snapshot, c.tool)) return undefined;
      const described = this.describe(c, snapshot);
      const view = candidateView(c, described.target, described.operation);
      entry = this.options.history.put({
        id: randomUUID(), at: Date.now(), updatedAt: Date.now(), sessionId: sanitize(c.sessionId, 200), project: sanitizePath(c.project),
        cwd: view.cwd, actor: view.actor as HistoryEntry["actor"], callId: sanitize(c.callId, 200), leafId: c.leafId,
        tool: c.tool, summary: c.tool === "bash" ? String((view.args as { command: string }).command) : `${c.tool} ${view.target}`,
        target: view.target, operation: view.operation,
        action: "Ask", origin: "policy", reason: "Assessment in progress; no execution observed.", policyIds: [], historyIds: [],
        state: "assessing", execution: "not-observed",
      });
      // Keep one config snapshot for this call. Concurrent UI edits apply to subsequent calls.
      const decision = described.decision ?? (!snapshot.config.judgeEnabled ? ruleOnlyAllow() : await judge(this.options.bridge, snapshot.config, c, described.natural,
        relevantHistory(this.options.history.list(), c, described.target, described.operation, described.natural.map((p) => p.id)), described.target, described.operation, combined));
      entry = { ...entry, ...decision, state: decision.action === "Ask" ? "review" : decision.action === "Deny" ? "denied" : "allowed", updatedAt: Date.now() };
      if (combined.aborted) entry = { ...entry, state: "denied", reason: "Assessment cancelled. Tool not authorized." };
      if (entry.state === "review") {
        this.options.history.put(entry);
        if (c.actor.kind === "main" && approval && !combined.aborted) {
          // Native select also receives the signal. This deadline prevents a stuck UI retaining a call forever.
          const choice = await bounded((uiSignal) => approval!(entry!, uiSignal), 300000, combined).catch(() => "deny" as const);
          entry = { ...entry, choice, state: choice === "allow-once" && !combined.aborted ? "allowed" : "denied" };
        } else {
          entry = { ...entry, state: "denied", reason: `${entry.reason} ${c.actor.kind === "subagent" ? "Worker Ask is blocked; try a safe alternative or report the blocker to the parent." : "No interactive approval available."}` };
        }
      }
      entry.execution = entry.state === "denied" ? "blocked" : "not-observed";
      entry.updatedAt = Date.now();
      entry = this.options.history.put(entry);
      this.calls.set(this.key(c), entry);
      if (this.calls.size > 2000) this.calls.delete(this.calls.keys().next().value!);
      return entry.state === "denied" ? { block: true, reason: sanitize(`Guardrails: ${entry.reason}${entry.choice ? ` Human choice: ${entry.choice}.` : ""}`), ...(entry.choice === "deny-stop" ? { terminate: true } : {}) } : undefined;
    } catch {
      // A broken history/config/path resolver never silently grants permission.
      if (entry) {
        try { this.options.history.put({ ...entry, state: "denied", execution: "blocked", origin: "error", reason: "Guardrails assessment or history storage failed. Tool blocked.", updatedAt: Date.now() }); } catch { /* Surface a safe fixed error below. */ }
      }
      return { block: true, reason: "Guardrails assessment or history storage failed. Tool blocked; repair the configuration or local storage." };
    }
  }
  result(c: Pick<Candidate, "callId" | "sessionId" | "actor">, isError: boolean): void {
    const key = this.key(c);
    const entry = this.calls.get(key);
    this.calls.delete(key);
    if (!entry || entry.state !== "allowed" || this.options.signal.aborted) return;
    // Pi reports a result, not an independently verified real-world effect. Never store its body.
    try { this.options.history.put({ ...entry, execution: isError ? "reported-error" : "reported-success", updatedAt: Date.now() }); } catch { /* The already executed tool cannot be undone. */ }
  }
}
