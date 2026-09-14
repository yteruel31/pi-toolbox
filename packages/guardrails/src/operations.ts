import type { Candidate } from "./types.js";
import type { Policy } from "./config.js";

export const operationTools = ["mcp", "web-access"] as const;
export type OperationTool = typeof operationTools[number];
export function isOperationTool(tool: string): tool is OperationTool { return operationTools.includes(tool as OperationTool); }
export const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
export function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function safeArgumentPath(path: string): boolean {
  const parts = path.split(".");
  return path.length <= 256 && parts.length <= 12 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part) && !forbiddenKeys.has(part));
}
/** Own data properties only: never follow prototypes, invoke getters or evaluate expressions. */
export function argumentAt(args: Record<string, unknown>, path: string): unknown {
  if (!safeArgumentPath(path)) return undefined;
  let value: unknown = args;
  for (const part of path.split(".")) {
    if (!plainObject(value) && !Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, part);
    if (!descriptor || !("value" in descriptor)) return undefined;
    value = descriptor.value;
  }
  return value;
}
/** Reject exotic/cyclic data before matching or redaction. This does not serialize raw arguments. */
export function boundedJson(value: unknown): boolean {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): boolean {
    if (++nodes > 4096 || depth > 12) return false;
    if (v === null || typeof v === "boolean") { bytes += 5; return bytes <= 64000; }
    if (typeof v === "number") { bytes += 24; return Number.isFinite(v) && bytes <= 64000; }
    if (typeof v === "string") { bytes += Buffer.byteLength(v); return bytes <= 64000; }
    if ((!plainObject(v) && !Array.isArray(v)) || seen.has(v)) return false;
    seen.add(v);
    if (Array.isArray(v) && (v.length > 256 || Object.keys(v).length !== v.length)) return false;
    const keys = Reflect.ownKeys(v);
    if (keys.length > 257) return false;
    for (const key of keys) {
      if (Array.isArray(v) && key === "length") continue;
      if (typeof key !== "string" || forbiddenKeys.has(key) || key.length > 256) return false;
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) return false;
      bytes += Buffer.byteLength(key) + 4;
      const d = Object.getOwnPropertyDescriptor(v, key)!;
      if (!d.enumerable || !("value" in d) || !visit(d.value, depth + 1)) return false;
    }
    seen.delete(v);
    return bytes <= 64000;
  }
  try { return visit(value, 0); } catch { return false; }
}
export function parsedUrl(value: string): URL | undefined {
  try {
    if (value.length > 4096 || /[\s\x00-\x1f\x7f\\]/.test(value) || !/^(https?|file):\/\//i.test(value)) return undefined;
    const url = new URL(value);
    if (url.protocol !== "file:" && !url.hostname) return undefined;
    return url;
  } catch { return undefined; }
}
export function hostname(url: URL): string { return url.hostname.toLowerCase().replace(/\.$/, ""); }
export function validDomain(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\.$/, "");
  const dns = normalized.split(".").every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  if (!dns && !/^\[[a-f0-9:]+\]$/.test(normalized)) return false;
  const url = parsedUrl(`https://${value}/`);
  return Boolean(url && !url.port && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" && value.toLowerCase().replace(/\.$/, "") === hostname(url));
}
function urlPath(url: URL): string | undefined {
  // Encoded separators/dots/percent can be reinterpreted by downstream servers. Never prove an Allow with them.
  if (/%(?:2f|5c|2e|25)/i.test(url.pathname)) return undefined;
  try { return decodeURIComponent(url.pathname); } catch { return undefined; }
}
export function validUrlPrefix(value: string): boolean {
  const url = parsedUrl(value);
  return Boolean(url && url.protocol !== "file:" && !url.username && !url.password && !url.search && !url.hash && urlPath(url) !== undefined);
}
export function matchesUrlPrefix(url: URL, prefix: string, conservative = false): boolean {
  const base = parsedUrl(prefix);
  if (!base || !validUrlPrefix(prefix) || base.protocol !== url.protocol || hostname(base) !== hostname(url) || base.port !== url.port) return false;
  const path = urlPath(url), root = urlPath(base)!.replace(/\/$/, "");
  return path === undefined ? conservative : path === root || path.startsWith(`${root}/`);
}
export interface OperationArgs extends Record<string, unknown> {
  operation: string;
  toolName?: string;
  server?: string;
  urls?: string[];
  arguments: Record<string, unknown>;
}
export function validOperationArgs(value: unknown): value is OperationArgs {
  if (!boundedJson(value) || !plainObject(value)) return false;
  const fields = ["operation", "toolName", "server", "urls", "arguments"];
  if (Object.keys(value).some((k) => !fields.includes(k)) || fields.some((k) => !Object.hasOwn(value, k) && k in value)) return false;
  const label = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v);
  return Object.hasOwn(value, "operation") && Object.hasOwn(value, "arguments") && label(value.operation) && (value.toolName === undefined || label(value.toolName)) && (value.server === undefined || label(value.server))
    && plainObject(value.arguments) && (value.urls === undefined || (Array.isArray(value.urls) && value.urls.length <= 32 && value.urls.every((u) => typeof u === "string" && Boolean(parsedUrl(u)))));
}
export function operationTarget(c: Candidate): string {
  if (!validOperationArgs(c.args)) return "[invalid operation target]";
  const domains = [...new Set((c.args.urls ?? []).map((u) => { const url = parsedUrl(u)!; return url.protocol === "file:" ? "file:[local target]" : hostname(url); }))];
  return [c.args.server ? `server:${c.args.server}` : undefined, c.args.toolName ? `tool:${c.args.toolName}` : undefined, ...domains].filter(Boolean).join(" · ") || `${c.tool}:${c.args.operation}`;
}
/** Identifiable output destinations only; arbitrary server-side MCP semantics remain unknown. */
export function operationOutputPaths(c: Candidate): string[] {
  if (!isOperationTool(c.tool) || !validOperationArgs(c.args)) return [];
  const paths: string[] = [];
  const visit = (value: unknown, parent = "") => {
    if (!plainObject(value) && !Array.isArray(value)) return;
    for (const [key, v] of Object.entries(value)) {
      if (typeof v === "string" && (/^(?:outputPath|outputFile|outputDir|output_path|output_file|savePath|saveTo|reportPath|destinationPath)$/i.test(key)
        || (parent === "destination" && /^(?:file|directory|path)$/.test(key)))) paths.push(v);
      else visit(v, key);
    }
  };
  visit(c.args.arguments);
  return paths;
}

/** URL conditions apply to the same URL; a batch Allow must cover every URL. */
export function operationMatches(p: Policy, c: Candidate): boolean {
  const q = p.conditions;
  const hasConditions = q.operation !== undefined || q.server !== undefined || q.toolName !== undefined
    || q.domain !== undefined || q.urlPrefix !== undefined || q.argumentMatches !== undefined;
  if (!isOperationTool(c.tool)) return !hasConditions;
  if (!validOperationArgs(c.args)) return false;
  const args = c.args;
  if ((q.operation !== undefined && q.operation !== args.operation)
    || (q.server !== undefined && q.server !== args.server)
    || (q.toolName !== undefined && q.toolName !== args.toolName)) return false;
  if (q.argumentMatches && !Object.entries(q.argumentMatches).every(([path, expected]) => argumentAt(args.arguments, path) === expected)) return false;
  if (q.domain === undefined && q.urlPrefix === undefined) return true;
  if (!args.urls?.length) return false;
  const matches = (value: string) => {
    const url = parsedUrl(value)!;
    const domain = q.domain?.toLowerCase().replace(/\.$/, "");
    if (domain !== undefined && (url.protocol === "file:" || !(hostname(url) === domain || (q.includeSubdomains === true && hostname(url).endsWith(`.${domain}`))))) return false;
    return q.urlPrefix === undefined || matchesUrlPrefix(url, q.urlPrefix, p.action !== "Allow");
  };
  return p.action === "Allow" ? args.urls.every(matches) : args.urls.some(matches);
}

/** Human dry-run input only. Plain text remains a bash command; operation JSON is explicit. */
export function parseDryRunInput(text: string, mode: "auto" | "bash" = "auto"): Pick<Candidate, "tool" | "args"> {
  if (mode === "bash" || !text.trimStart().startsWith("{")) {
    if (!text.trim() || text.length > 16000) throw new Error("Expected a command of at most 16000 characters");
    return { tool: "bash", args: { command: text } };
  }
  if (Buffer.byteLength(text) > 64000) throw new Error("Operation test exceeds the input budget");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Expected operation JSON: {tool, args}"); }
  if (!boundedJson(value) || !plainObject(value) || Object.keys(value).some((k) => k !== "tool" && k !== "args")
    || typeof value.tool !== "string" || !isOperationTool(value.tool) || !validOperationArgs(value.args)) {
    throw new Error("Expected {tool: mcp or web-access, args: {operation, toolName?, server?, urls?, arguments}}");
  }
  return { tool: value.tool, args: value.args };
}
