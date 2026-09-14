import type { GuardrailsEngine } from "./engine.js";
import { isTool, type Actor, type Block, type Candidate } from "./types.js";

/** Structural protocol shared with pi-subagents, with no runtime package dependency. */
export const CHILD_CHANNEL = "pi-toolbox:guardrails:pi-child:v1";
export interface ChildRequest {
  v: 1;
  parentSessionId: string;
  runId: string;
  profile?: string;
  cwd: string;
  signal: AbortSignal;
  provide(gate: {
    assess(event: { toolName: string; toolCallId: string; input: Record<string, unknown>; childSessionId: string }): Promise<Block | undefined>;
    result(event: { toolCallId: string; childSessionId: string; isError: boolean }): void;
  }): void;
}
export function provideChildGate(data: unknown, engine: GuardrailsEngine, parent: { sessionId: string; project: string; signal: AbortSignal }): void {
  const r = data as Partial<ChildRequest> | undefined;
  if (!r || r.v !== 1 || r.parentSessionId !== parent.sessionId || typeof r.provide !== "function" || typeof r.runId !== "string" || typeof r.cwd !== "string" || !(r.signal instanceof AbortSignal)) return;
  const request = r as ChildRequest;
  // Pin attribution and lifetime at run creation. Never resolve a later parent session.
  const signal = AbortSignal.any([parent.signal, request.signal]);
  const actor = (childSessionId: string): Actor => ({ kind: "subagent", runId: request.runId, profile: request.profile, childSessionId });
  request.provide({
    async assess(event) {
      if (signal.aborted) return { block: true, reason: "Parent guardrails session or child run has ended." };
      if (!isTool(event.toolName)) return undefined;
      const candidate: Candidate = { tool: event.toolName, args: event.input, cwd: request.cwd, actor: actor(event.childSessionId), callId: event.toolCallId, sessionId: parent.sessionId, project: parent.project };
      return engine.assess(candidate, undefined, signal);
    },
    result(event) { if (!signal.aborted) engine.result({ callId: event.toolCallId, sessionId: parent.sessionId, actor: actor(event.childSessionId) }, event.isError); },
  });
}
