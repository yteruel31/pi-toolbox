import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lookupKeyring } from "./keyring.js";

export interface WebConfig {
  enabled: boolean;
  search: { provider?: "gemini" | "openai" | "brave"; geminiModel: string; openaiModel: string };
  credentials: { gemini: string; openai: string; brave: string };
  synthesisModel?: string;
  research: { outputDir: string; geminiModel: string; openaiModel: string; pollIntervalMs: number };
  fetch: { timeoutMs: number; maxBytes: number; maxPdfPages: number; javascript: "auto" | "never" };
  cache: { directory: string; maxEntries: number; maxBytes: number; ttlMs: number; inlineChars: number };
}
export function configPath(agentDir = getAgentDir()): string { return join(agentDir, "web-access.json"); }
function object(value: unknown, label: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key))) throw new Error(`${label} contains an unsupported setting`);
  return result;
}
function text(value: unknown, fallback: string, label: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error(`${label} must be a non-empty single-line string`);
  return value;
}
function number(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value as number;
}
export function parseConfig(value: unknown, agentDir: string): WebConfig {
  const root = object(value, "web-access", ["enabled", "search", "credentials", "synthesisModel", "research", "fetch", "cache"]);
  const search = object(root.search ?? {}, "search", ["provider", "geminiModel", "openaiModel"]);
  const credentials = object(root.credentials ?? {}, "credentials", ["gemini", "openai", "brave"]);
  const research = object(root.research ?? {}, "research", ["outputDir", "geminiModel", "openaiModel", "pollIntervalMs"]);
  const fetch = object(root.fetch ?? {}, "fetch", ["timeoutMs", "maxBytes", "maxPdfPages", "javascript"]);
  const cache = object(root.cache ?? {}, "cache", ["directory", "maxEntries", "maxBytes", "ttlMs", "inlineChars"]);
  if (root.enabled !== undefined && typeof root.enabled !== "boolean") throw new Error("enabled must be boolean");
  if (search.provider !== undefined && !["gemini", "openai", "brave"].includes(search.provider as string)) throw new Error("search.provider must be gemini, openai or brave");
  if (fetch.javascript !== undefined && !["auto", "never"].includes(fetch.javascript as string)) throw new Error("fetch.javascript must be auto or never");
  const outputDir = text(research.outputDir, join(agentDir, "web-access", "reports"), "research.outputDir");
  const directory = text(cache.directory, join(agentDir, "web-access", "cache"), "cache.directory");
  if (!isAbsolute(outputDir) || !isAbsolute(directory)) throw new Error("Configured output and cache directories must be absolute paths");
  return {
    enabled: root.enabled !== false,
    search: { provider: search.provider as WebConfig["search"]["provider"], geminiModel: text(search.geminiModel, "gemini-3.6-flash", "search.geminiModel"), openaiModel: text(search.openaiModel, "gpt-5-mini", "search.openaiModel") },
    credentials: { gemini: text(credentials.gemini, "$GEMINI_API_KEY", "credentials.gemini"), openai: text(credentials.openai, "$OPENAI_API_KEY", "credentials.openai"), brave: text(credentials.brave, "$BRAVE_API_KEY", "credentials.brave") },
    synthesisModel: root.synthesisModel === undefined ? undefined : text(root.synthesisModel, "", "synthesisModel"),
    research: { outputDir, geminiModel: text(research.geminiModel, "deep-research-preview-04-2026", "research.geminiModel"), openaiModel: text(research.openaiModel, "o4-mini-deep-research", "research.openaiModel"), pollIntervalMs: number(research.pollIntervalMs, 10_000, 5_000, 300_000, "research.pollIntervalMs") },
    fetch: { timeoutMs: number(fetch.timeoutMs, 30_000, 1_000, 300_000, "fetch.timeoutMs"), maxBytes: number(fetch.maxBytes, 5 * 1024 * 1024, 1024, 20 * 1024 * 1024, "fetch.maxBytes"), maxPdfPages: number(fetch.maxPdfPages, 100, 1, 500, "fetch.maxPdfPages"), javascript: (fetch.javascript as "auto" | "never") ?? "auto" },
    cache: { directory, maxEntries: number(cache.maxEntries, 128, 1, 1024, "cache.maxEntries"), maxBytes: number(cache.maxBytes, 128 * 1024 * 1024, 1024, 512 * 1024 * 1024, "cache.maxBytes"), ttlMs: number(cache.ttlMs, 3_600_000, 1_000, 86_400_000, "cache.ttlMs"), inlineChars: number(cache.inlineChars, 12_000, 100, 30_000, "cache.inlineChars") },
  };
}
export async function loadConfig(agentDir = getAgentDir()): Promise<WebConfig> {
  let data: string;
  try { data = await readFile(configPath(agentDir), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({}, agentDir); throw new Error("Cannot read web-access.json"); }
  if (Buffer.byteLength(data) > 64 * 1024) throw new Error("web-access.json exceeds 64 KiB");
  let value: unknown;
  try { value = JSON.parse(data); } catch { throw new Error("web-access.json is not valid JSON"); }
  return parseConfig(value, agentDir);
}
/** Only explicit references or literals. Never execute user-provided credential commands. */
export async function resolveKey(config: WebConfig, provider: keyof WebConfig["credentials"], env = process.env, signal?: AbortSignal): Promise<string> {
  const source = config.credentials[provider];
  if (source.startsWith("keyring:")) {
    if (source !== `keyring:pi-web-access/${provider}`) throw new Error("Invalid keyring reference; use keyring:pi-web-access/<matching-provider>");
    return lookupKeyring(provider, env, signal);
  }
  const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(source);
  if (source.startsWith("!") || (source.startsWith("$") && !match)) throw new Error(`Invalid ${provider} credential source; use a literal or $ENV_VAR`);
  const key = match ? env[match[1] ?? match[2]!] : source;
  if (!key || /[\s\x00-\x1f]/.test(key) || key.length > 16_384) throw new Error(`${provider} API key is missing or invalid; consumer subscriptions are not API credentials`);
  return key;
}
