import { stripVTControlCharacters } from "node:util";
import type { Candidate } from "./types.js";
import { boundedJson, isOperationTool, validOperationArgs } from "./operations.js";

/** Best effort, not a secret detector. Never pass file bodies or tool results here. */
export function sanitize(value: string, limit = 2000): string {
  return redact(value, limit, /\b[A-Za-z0-9+/_=-]{40,}\b/g);
}
/** Filesystem separators aren't entropy. Keep long paths while masking opaque components. */
export function sanitizePath(value: string, limit = 4096): string {
  return redact(value, limit, /\b[A-Za-z0-9+_=-]{40,}\b/g);
}
function redact(value: string, limit: number, opaque: RegExp): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^-]*-----|$)/g, "[private material omitted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s'";]+/gi, "[authorization omitted]")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]{16}|eyJ[\w.-]{16,})\b/g, "[credential omitted]")
    .replace(/([\w.-]*(?:token|secret|password|passwd|api.?key|credential)[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;&]+)/gi, "$1[redacted]")
    .replace(/((?:https?|file):\/\/)[^\s/@]+@/gi, "$1[credentials]@")
    .replace(/((?:https?|file):\/\/[^\s?'"#]+)[?#][^\s'" ]*/gi, "$1[query omitted]")
    .replace(opaque, "[long value omitted]")
    .slice(0, limit);
}
export function safeCommand(command: string): string {
  // Display only: embedded scripts, heredocs and quoted literals can contain arbitrary file bodies.
  if (command.length > 16000) return "[oversized command omitted]";
  if (/<<|\n|\r/.test(command)) return "[multiline command omitted; assessment requires approval]";
  return sanitize(command
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/g, "[assignment omitted]")
    .replace(/--?(?:password|passwd|token|secret|api-key|header|data|data-raw|user)\s+(?:"[^"]*"|'[^']*'|[^\s]+)/gi, "[sensitive option omitted]")
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "[quoted literal omitted]"), 4000);
}

const arithmeticTokens = /\d+(?:\.\d+)?|[()+*/%\-]/gy;
function boundedArithmetic(expression: string): boolean {
  if (!expression || expression.length > 200) return false;
  let offset = 0; let expectingValue = true; let depth = 0;
  while (offset < expression.length) {
    while (/\s/.test(expression[offset] ?? "")) offset++;
    if (offset === expression.length) break;
    arithmeticTokens.lastIndex = offset;
    const match = arithmeticTokens.exec(expression);
    if (!match || match.index !== offset) return false;
    const token = match[0]; offset = arithmeticTokens.lastIndex;
    if (/^\d/.test(token)) {
      if (!expectingValue || token.length > 20) return false;
      expectingValue = false;
    } else if (token === "(") {
      if (!expectingValue || ++depth > 8) return false;
    } else if (token === ")") {
      if (expectingValue || depth-- <= 0) return false;
    } else {
      if (expectingValue) return false;
      expectingValue = true;
    }
  }
  return !expectingValue && depth === 0;
}
/**
 * A classifier-only shell view. It preserves the original syntax only for a deliberately
 * tiny grammar whose literals cannot carry arbitrary text; everything else stays redacted.
 */
export function assessmentCommand(command: string): { command: string; complete: boolean } {
  const display = safeCommand(command);
  if (command.length > 16000 || /<<|\n|\r/.test(command)) return { command: display, complete: false };
  const match = command.match(/^\s*python(?:3(?:\.\d+)?)?\s+-c\s+(["'])([\s\S]*)\1\s*$/);
  if (!match) return { command: display, complete: display === command };
  const print = match[2].match(/^\s*print\s*\(([\s\S]*)\)\s*$/);
  if (!print || !boundedArithmetic(print[1])) return { command: display, complete: false };
  const evidenced = sanitize(command, 4000);
  return { command: evidenced, complete: evidenced === command };
}
const queryName = /^(?:query|q|search|filter|term)$/i;
const sensitiveName = /token|secret|password|passwd|api.?key|credential|authorization|cookie|header|body|content|payload|prompt|subject|text|html|data|document|attachment/i;
/** A bounded JSON display copy, never a serialization of unchecked objects/getters. */
export type AssessmentGap = "invalid-input" | "budget-truncation" | "sensitive-value" | "sanitized-value" | "hidden-write-body" | "shell-redaction";
export interface RedactedView { value: unknown; incomplete: boolean; gaps: AssessmentGap[] }
export function redactedArguments(value: unknown): RedactedView {
  if (!boundedJson(value)) return { value: "[invalid or oversized arguments omitted]", incomplete: true, gaps: ["invalid-input"] };
  let incomplete = false, nodes = 0, chars = 0;
  const gaps = new Set<AssessmentGap>();
  const omit = (gap: AssessmentGap = "budget-truncation") => { incomplete = true; gaps.add(gap); return "[omitted]"; };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 6 || chars > 8000) return omit();
    if (typeof v === "string") {
      const safe = sanitize(v, 1000);
      chars += safe.length;
      if (safe !== v) { incomplete = true; gaps.add("sanitized-value"); }
      return safe;
    }
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.slice(0, 32).map((item) => visit(item, depth + 1)).concat(v.length > 32 ? [omit()] : []);
    const result: Record<string, unknown> = Object.create(null);
    const entries = Object.entries(v);
    for (const [key, item] of entries.slice(0, 32)) {
      const safeKey = sanitize(key, 100);
      if (key !== safeKey) { incomplete = true; gaps.add("sanitized-value"); }
      chars += safeKey.length;
      result[safeKey] = sensitiveName.test(key) && !queryName.test(key) ? omit("sensitive-value") : visit(item, depth + 1);
    }
    if (entries.length > 32) result["[remaining arguments omitted]"] = omit();
    return result;
  };
  const result = visit(value, 0);
  return { value: result, incomplete, gaps: [...gaps] };
}
export function operationView(c: Candidate): RedactedView {
  if (!validOperationArgs(c.args)) return { value: "[invalid operation arguments omitted]", incomplete: true, gaps: ["invalid-input"] };
  return redactedArguments(c.args);
}
export function candidateView(c: Candidate, target: string, operation: string) {
  const operationArgs = isOperationTool(c.tool) ? operationView(c) : undefined;
  const cwd = sanitizePath(c.cwd);
  const safeTarget = operationArgs ? sanitize(target, 4096) : sanitizePath(target);
  const path = String(c.args.path ?? "");
  const safePath = sanitizePath(path);
  const gaps = new Set<AssessmentGap>(operationArgs?.gaps ?? []);
  if (cwd !== c.cwd || safeTarget !== target || (!operationArgs && c.tool !== "bash" && path !== safePath)) gaps.add("sanitized-value");
  if (!operationArgs && (c.tool === "write" || c.tool === "edit")) gaps.add("hidden-write-body");
  const command = c.tool === "bash" ? String(c.args.command ?? "") : "";
  const shellView = c.tool === "bash" ? assessmentCommand(command) : { command: "", complete: true };
  const safeShell = shellView.command;
  if (c.tool === "bash" && !shellView.complete) gaps.add("shell-redaction");
  const incomplete = gaps.size > 0;
  return {
    tool: c.tool, cwd, actor: c.actor.kind === "main" ? { kind: "main" } : {
      kind: "subagent", runId: sanitize(c.actor.runId, 100), profile: c.actor.profile ? sanitize(c.actor.profile, 100) : undefined,
      childSessionId: c.actor.childSessionId ? sanitize(c.actor.childSessionId, 100) : undefined,
    },
    assessmentIncomplete: Boolean(incomplete), assessmentGaps: [...gaps],
    args: operationArgs ? operationArgs.value : c.tool === "bash" ? { command: safeShell } : {
      path: safePath,
      ...(c.tool === "read" ? { offset: Number(c.args.offset) || undefined, limit: Number(c.args.limit) || undefined } : { body: "[omitted]" }),
    },
    target: safeTarget, operation: sanitize(operation, 100),
  };
}
