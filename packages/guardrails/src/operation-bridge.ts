import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OperationGate, OperationRequest } from "@yteruel31/pi-operation-hooks";
import type { Approval, GuardrailsEngine } from "./engine.js";
import type { Candidate } from "./types.js";
import { bypasses, type ConfigStore } from "./config.js";

export interface OperationRuntime {
  sessionId: string;
  project: string;
  controller: AbortController;
  ctx: ExtensionContext;
  engine?: GuardrailsEngine;
  store?: Pick<ConfigStore, "load">;
}
/** Operation callbacks never depend on a tool-name guess or MCP's readOnly annotation. */
export function provideOperationGate(
  request: OperationRequest,
  current: OperationRuntime | undefined,
  approval: (ctx: ExtensionContext) => Approval | undefined,
): OperationGate {
  const ctx = request.context as ExtensionContext | undefined;
  const unavailable = (): OperationGate => ({ assess: async () => ({ block: true, reason: "Guardrails is not ready for this operation's session." }) });
  if (!current || current.controller.signal.aborted || !ctx || typeof ctx.cwd !== "string" ||
      typeof ctx.sessionManager?.getSessionId !== "function" || ctx.sessionManager.getSessionId() !== current.sessionId ||
      !request.operation || !["mcp", "web-access"].includes(request.operation.package)) return unavailable();
  const engine = current.engine;
  if (!engine) return { assess: async () => {
    // Explicit Off remains usable even when history storage needs repair.
    const snapshot = await current.store?.load(ctx.isProjectTrusted());
    if (snapshot && bypasses(snapshot, request.operation.package) && !current.controller.signal.aborted) return undefined;
    return { block: true, reason: "Guardrails storage is unavailable. Repair it before enabling protection." };
  } };
  const op = request.operation;
  const candidate: Candidate = {
    tool: op.package, args: { operation: op.name, ...(op.toolName !== undefined ? { toolName: op.toolName } : {}), ...(op.server !== undefined ? { server: op.server } : {}), ...(op.urls !== undefined ? { urls: op.urls } : {}), arguments: op.args },
    cwd: ctx.cwd, project: current.project, sessionId: current.sessionId, actor: { kind: "main" },
    callId: `operation-${request.id}`, leafId: ctx.sessionManager.getLeafId() ?? undefined,
  };
  return {
    async assess(signal) {
      if (current.controller.signal.aborted || ctx.sessionManager.getSessionId() !== current.sessionId) return { block: true, reason: "Guardrails operation belongs to an ended session." };
      current.ctx = ctx;
      const combined = AbortSignal.any([signal, current.controller.signal, ...(ctx.signal ? [ctx.signal] : [])]);
      const block = await engine.assess(candidate, approval(ctx), combined);
      // The engine journals the human choice before native turn cancellation.
      if (block?.terminate) void ctx.abort();
      return block;
    },
    result(isError) { engine.result(candidate, isError); },
  };
}
