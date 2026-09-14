import { stripVTControlCharacters } from "node:util";
import type { Candidate } from "./types.js";
import { boundedJson, isOperationTool, validOperationArgs } from "./operations.js";

/** Best effort, not a secret detector. Never pass file bodies or tool results here. */
export function sanitize(value: string, limit = 2000): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^-]*-----|$)/g, "[private material omitted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s'";]+/gi, "[authorization omitted]")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]{16}|eyJ[\w.-]{16,})\b/g, "[credential omitted]")
    .replace(/([\w.-]*(?:token|secret|password|passwd|api.?key|credential)[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;&]+)/gi, "$1[redacted]")
    .replace(/((?:https?|file):\/\/)[^\s/@]+@/gi, "$1[credentials]@")
    .replace(/((?:https?|file):\/\/[^\s?'"#]+)[?#][^\s'" ]*/gi, "$1[query omitted]")
    .replace(/\b[A-Za-z0-9+/_=-]{40,}\b/g, "[long value omitted]")
    .slice(0, limit);
}
export function safeCommand(command: string): string {
  // Embedded scripts, heredocs and quoted literals can contain arbitrary file bodies.
  if (command.length > 16000) return "[oversized command omitted]";
  if (/<<|\n|\r/.test(command)) return "[multiline command omitted; assessment requires approval]";
  return sanitize(command
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/g, "[assignment omitted]")
    .replace(/--?(?:password|passwd|token|secret|api-key|header|data|data-raw|user)\s+(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "[sensitive option omitted]")
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "[quoted literal omitted]"), 4000);
}
const sensitiveName = /token|secret|password|passwd|api.?key|credential|authorization|cookie|header|body|content|payload|query|prompt|subject|text|html|data|document|attachment/i;
/** A bounded JSON display copy, never a serialization of unchecked objects/getters. */
export function redactedArguments(value: unknown): { value: unknown; incomplete: boolean } {
  if (!boundedJson(value)) return { value: "[invalid or oversized arguments omitted]", incomplete: true };
  let incomplete = false, nodes = 0, chars = 0;
  const omit = () => { incomplete = true; return "[omitted]"; };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 6 || chars > 8000) return omit();
    if (typeof v === "string") {
      const safe = sanitize(v, 1000);
      chars += safe.length;
      if (safe !== v) incomplete = true;
      return safe;
    }
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.slice(0, 32).map((item) => visit(item, depth + 1)).concat(v.length > 32 ? [omit()] : []);
    const result: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(v);
    for (const [key, item] of entries.slice(0, 32)) {
      const safeKey = sanitize(key, 100);
      if (key !== safeKey) incomplete = true;
      chars += safeKey.length;
      result[safeKey] = sensitiveName.test(key) ? omit() : visit(item, depth + 1);
    }
    if (entries.length > 32) result["[remaining arguments omitted]"] = omit();
    return result;
  };
  const result = visit(value, 0);
  return { value: result, incomplete };
}
export function operationView(c: Candidate): { value: unknown; incomplete: boolean } {
  if (!validOperationArgs(c.args)) return { value: "[invalid operation arguments omitted]", incomplete: true };
  return redactedArguments(c.args);
}
export function candidateView(c: Candidate, target: string, operation: string) {
  const operationArgs = isOperationTool(c.tool) ? operationView(c) : undefined;
  return {
    tool: c.tool, cwd: sanitize(c.cwd, 4096), actor: c.actor.kind === "main" ? { kind: "main" } : {
      kind: "subagent", runId: sanitize(c.actor.runId, 100), profile: c.actor.profile ? sanitize(c.actor.profile, 100) : undefined,
      childSessionId: c.actor.childSessionId ? sanitize(c.actor.childSessionId, 100) : undefined,
    },
    ...(operationArgs ? { assessmentIncomplete: operationArgs.incomplete } : {}),
    args: operationArgs ? operationArgs.value : c.tool === "bash" ? { command: safeCommand(String(c.args.command ?? "")) } : {
      path: sanitize(String(c.args.path ?? ""), 4096),
      ...(c.tool === "read" ? { offset: Number(c.args.offset) || undefined, limit: Number(c.args.limit) || undefined } : { body: "[omitted]" }),
    },
    target: sanitize(target, 4096), operation: sanitize(operation, 100),
  };
}
