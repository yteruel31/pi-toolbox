import { randomUUID } from "node:crypto";
import { bypasses, type ConfigSnapshot } from "./config.js";
import type { Block, Candidate, Decision, HistoryEntry } from "./types.js";
import type { CompletionBridge } from "./judge.js";
import { bounded, judge } from "./judge.js";
import { judgeJev, type JevFetch } from "./jev-client.js";
import { HistoryStore, relevantHistory } from "./history.js";
import { evaluatePolicies } from "./policies.js";
import { candidateView, sanitize, sanitizePath } from "./sanitize.js";
import type { DeliveryContent } from "@yteruel31/pi-operation-hooks";
import { incomingEvidence, type IncomingAssessment } from "./incoming.js";
import { judgeIncomingJev, judgeIncomingPi } from "./incoming-judge.js";

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
  jevCredential?: (config: ConfigSnapshot["config"], signal: AbortSignal) => Promise<string>;
  jevFetch?: JevFetch;
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
    const decision = await this.modelDecision(snapshot, c, evaluated.natural, history, evaluated.target, evaluated.operation, signal);
    return { ...evaluated, enabled: true, decision };
  }
  private describe(c: Candidate, snapshot: ConfigSnapshot): ReturnType<typeof evaluatePolicies> {
    const sensitivePaths = snapshot.config.jev.credential.source === "file" ? [snapshot.config.jev.credential.reference] : [];
    const evaluated = evaluatePolicies(c, snapshot.error ? [] : snapshot.policies, this.options.protectedPaths, snapshot.config.judgeEnabled, sensitivePaths);
    if (snapshot.error && evaluated.decision?.action !== "Deny") evaluated.decision = this.configError(snapshot);
    return evaluated;
  }
  private async modelDecision(snapshot: ConfigSnapshot, c: Candidate, natural: ConfigSnapshot["policies"], history: HistoryEntry[], target: string, operation: string, signal?: AbortSignal): Promise<Decision> {
    if (snapshot.config.backend === "pi") return judge(this.options.bridge, snapshot.config, c, natural, history, target, operation, signal);
    const credential = this.options.jevCredential;
    if (!credential) return { action: snapshot.config.errorBehavior === "deny" ? "Deny" : "Ask", origin: "error", reason: "Jev credentials are unavailable. Human approval required; headless calls are blocked.", policyIds: [], historyIds: [] };
    try {
      return await bounded(async deadlineSignal => {
        let key: string;
        try { key = await credential(snapshot.config, deadlineSignal); }
        catch (error) {
          if (deadlineSignal.aborted) throw error;
          return { action: snapshot.config.errorBehavior === "deny" ? "Deny" : "Ask", origin: "error", failure: "credentials", reason: "Jev credentials are unavailable. Human approval required; headless calls are blocked.", policyIds: [], historyIds: [] } as Decision;
        }
        return judgeJev({ config: snapshot.config, apiKey: key, candidate: c, policies: natural, history, target, operation, signal: deadlineSignal, fetchImpl: this.options.jevFetch, deadlineOwned: true });
      }, snapshot.config.timeoutMs, signal);
    } catch {
      const cancelled = Boolean(signal?.aborted);
      return { action: cancelled || snapshot.config.errorBehavior === "deny" ? "Deny" : "Ask", origin: "error", failure: cancelled ? "cancelled" : "timeout", reason: cancelled ? "Assessment cancelled. Tool not authorized." : "Jev assessment timed out. Human approval required; headless calls are blocked.", policyIds: [], historyIds: [] };
    }
  }
  private async classifyIncoming(snapshot: ConfigSnapshot, delivery: DeliveryContent, signal: AbortSignal): Promise<{ assessment: IncomingAssessment; reason: string; failure?: Decision["failure"] }> {
    if (signal.aborted) return { assessment: "incomplete", failure: "cancelled", reason: "Incoming delivery assessment was cancelled." };
    if (snapshot.error) return { assessment: "incomplete", reason: "Incoming delivery configuration is unavailable." };
    const evidence = incomingEvidence(delivery);
    if (!snapshot.config.judgeEnabled) return { assessment: evidence.assessment, reason: evidence.assessment === "clean" ? "No deterministic active instruction pattern was found; content remains untrusted." : "Incoming content is suspicious or could not be inspected completely." };
    if (evidence.assessment === "suspicious") return { assessment: "suspicious", reason: "Incoming content contains active instruction-like text." };
    if (evidence.incomplete) return { assessment: "incomplete", reason: "Incoming content could not be inspected completely." };
    try {
      const judged = snapshot.config.backend === "pi"
        ? await judgeIncomingPi(this.options.bridge, snapshot.config, evidence, signal)
        : await bounded(async deadlineSignal => {
            if (!this.options.jevCredential) throw new Error("credentials unavailable");
            const key = await this.options.jevCredential(snapshot.config, deadlineSignal);
            return judgeIncomingJev(snapshot.config, key, evidence, deadlineSignal, this.options.jevFetch);
          }, snapshot.config.timeoutMs, signal);
      return { assessment: judged.action, reason: judged.action === "clean" ? "The classifier found only benign content; it remains untrusted data." : "Incoming content may contain an active instruction or lacks complete evidence." };
    } catch (error) {
      const cancelled = signal.aborted;
      const message = error instanceof Error ? error.message : "";
      const failure: Decision["failure"] = cancelled ? "cancelled" : /timed out|timeout/i.test(message) ? "timeout" : /invalid|too large|JSON|choice|probabilit/i.test(message) ? "invalid-response" : /credential/i.test(message) ? "credentials" : "transport";
      return { assessment: "incomplete", failure, reason: cancelled ? "Incoming delivery assessment was cancelled." : "Incoming classifier failed; human approval is required." };
    }
  }
  async inspectIncoming(c: Candidate, delivery: DeliveryContent, approval?: Approval, signal?: AbortSignal): Promise<Block | undefined> {
    const combined = AbortSignal.any([this.options.signal, ...(signal ? [signal] : [])]);
    if (combined.aborted) return { block: true, reason: "Operation result withheld because delivery inspection was cancelled." };
    let entry: HistoryEntry | undefined;
    try {
      const snapshot = await this.options.load();
      if (bypasses(snapshot, c.tool)) return undefined;
      entry = this.options.history.put({
        id: randomUUID(), at: Date.now(), updatedAt: Date.now(), sessionId: sanitize(c.sessionId, 200), project: sanitizePath(c.project), cwd: sanitizePath(c.cwd),
        actor: c.actor, callId: sanitize(`${c.callId}:incoming`, 200), leafId: c.leafId, tool: c.tool,
        summary: `Incoming ${c.tool} result`, target: "untrusted operation result", operation: "incoming-delivery",
        action: "Ask", origin: "policy", reason: "Incoming delivery assessment in progress; result body is not recorded.", policyIds: [], historyIds: [], state: "assessing", execution: "not-observed",
      });
      const assessed = await this.classifyIncoming(snapshot, delivery, combined);
      if (combined.aborted) {
        entry = { ...entry, action: "Deny", origin: "error", failure: "cancelled", reason: "Incoming delivery assessment was cancelled.", state: "denied", execution: "blocked", updatedAt: Date.now() };
      } else if (assessed.assessment === "clean") {
        entry = { ...entry, action: "Allow", origin: snapshot.config.judgeEnabled ? "model" : "rule-only-no-match", reason: assessed.reason, state: "allowed", execution: "not-observed", updatedAt: Date.now() };
      } else {
        entry = { ...entry, action: "Ask", origin: assessed.failure ? "error" : "policy", ...(assessed.failure ? { failure: assessed.failure } : {}), reason: assessed.reason, state: "review", updatedAt: Date.now() };
        this.options.history.put(entry);
        if (c.actor.kind === "main" && approval && !combined.aborted) {
          const choice = await bounded((uiSignal) => approval(entry!, uiSignal), 300000, combined).catch(() => "deny" as const);
          entry = { ...entry, choice, state: choice === "allow-once" && !combined.aborted ? "allowed" : "denied" };
        } else entry = { ...entry, state: "denied", reason: `${entry.reason} No interactive approval available.` };
        entry.execution = entry.state === "denied" ? "blocked" : "not-observed";
        entry.updatedAt = Date.now();
      }
      entry = this.options.history.put(entry);
      return entry.state === "denied" ? { block: true, reason: sanitize(`Guardrails: ${entry.reason}${entry.choice ? ` Human choice: ${entry.choice}.` : ""}`), ...(entry.choice === "deny-stop" ? { terminate: true } : {}) } : undefined;
    } catch {
      if (entry) { try { this.options.history.put({ ...entry, action: "Deny", origin: "error", reason: "Incoming assessment or history storage failed. Result withheld.", state: "denied", execution: "blocked", updatedAt: Date.now() }); } catch {} }
      return { block: true, reason: "Operation result withheld because guardrails assessment or history storage failed." };
    }
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
      const decision = described.decision ?? (!snapshot.config.judgeEnabled ? ruleOnlyAllow() : await this.modelDecision(snapshot, c, described.natural,
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
