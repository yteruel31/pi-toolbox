import { stripVTControlCharacters } from "node:util";
import type { Candidate } from "./types.js";

/** Best effort, not a secret detector. Never pass file bodies or tool results here. */
export function sanitize(value: string, limit = 2000): string {
  return stripVTControlCharacters(value)
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^-]*-----|$)/g, "[private material omitted]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s'";]+/gi, "[authorization omitted]")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|AKIA[A-Z0-9]{16}|eyJ[\w.-]{16,})\b/g, "[credential omitted]")
    .replace(/([\w.-]*(?:token|secret|password|passwd|api.?key|credential)[\w.-]*\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;&]+)/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[credentials]@")
    .replace(/(https?:\/\/[^\s?'"#]+)[?#][^\s'" ]*/gi, "$1[query omitted]")
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
export function candidateView(c: Candidate, target: string, operation: string) {
  return {
    tool: c.tool, cwd: sanitize(c.cwd, 4096), actor: c.actor.kind === "main" ? { kind: "main" } : {
      kind: "subagent", runId: sanitize(c.actor.runId, 100), profile: c.actor.profile ? sanitize(c.actor.profile, 100) : undefined,
      childSessionId: c.actor.childSessionId ? sanitize(c.actor.childSessionId, 100) : undefined,
    },
    args: c.tool === "bash" ? { command: safeCommand(String(c.args.command ?? "")) } : {
      path: sanitize(String(c.args.path ?? ""), 4096),
      ...(c.tool === "read" ? { offset: Number(c.args.offset) || undefined, limit: Number(c.args.limit) || undefined } : { body: "[omitted]" }),
    },
    target: sanitize(target, 4096), operation: sanitize(operation, 100),
  };
}
