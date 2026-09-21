import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Tool } from "./types.js";
import { boundedJson, safeArgumentPath, validDomain, validUrlPrefix } from "./operations.js";

const text = (max: number) => z.string().min(1).max(max).refine((v) => !/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/.test(v), "Control characters are not allowed");
export const conditionSchema = z.object({
  preset: z.enum(["git", "files", "system", "production", "secrets"]).optional(),
  pathPrefix: text(4096).optional(),
  command: text(4096).optional(),
  operation: text(200).optional(),
  server: text(200).optional(),
  toolName: text(200).optional(),
  domain: text(253).refine(validDomain, "Expected a hostname without scheme, port or wildcards").optional(),
  includeSubdomains: z.boolean().optional(),
  urlPrefix: text(4096).refine(validUrlPrefix, "Expected an HTTP(S) URL without credentials, query or fragment").optional(),
  argumentMatches: z.record(z.string().refine(safeArgumentPath, "Unsafe argument path"), z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]))
    .refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 32 && boundedJson(v), "Expected 1-32 bounded scalar comparisons").optional(),
}).strict().refine((c) => c.includeSubdomains === undefined || c.domain !== undefined, "includeSubdomains requires domain");
export const policySchema = z.object({
  id: text(80).regex(/^[a-zA-Z0-9._-]+$/),
  name: text(120),
  enabled: z.boolean(),
  scope: z.enum(["main", "subagent", "both"]),
  tools: z.array(z.enum(["bash", "read", "write", "edit", "mcp", "web-access"])).min(1).max(6),
  conditions: conditionSchema,
  action: z.enum(["Allow", "Ask", "Deny"]),
  description: text(2000).optional(),
  kind: z.enum(["structured", "natural"]),
}).strict().refine((p) => p.kind !== "natural" || Boolean(p.description), "Natural policies need a description");
export type Policy = z.infer<typeof policySchema> & { source?: "global" | "project" };
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const jevCredentialSources = ["environment", "keyring", "file"] as const;
export type JevCredentialSource = typeof jevCredentialSources[number];
const jevSchema = z.object({
  model: z.literal("jev-latest").default("jev-latest"),
  allowThreshold: z.number().min(0.5).max(1).default(0.95),
  denyThreshold: z.number().min(0.5).max(1).default(0.8),
  credential: z.object({ source: z.enum(jevCredentialSources).default("environment"), reference: text(4096).default("TYPESAFE_API_KEY") }).strict()
    .refine((v) => v.source === "environment" ? /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(v.reference) : v.source === "keyring" ? v.reference === "pi-guardrails/jev" : v.reference.startsWith("/"), "Invalid Jev credential reference"),
}).strict();
export const coverageSchema = z.object({
  bash: z.boolean().default(true), read: z.boolean().default(true),
  write: z.boolean().default(true), edit: z.boolean().default(true),
  mcp: z.boolean().default(true), "web-access": z.boolean().default(true),
}).strict();
export const configSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  coverage: coverageSchema.default(() => coverageSchema.parse({})),
  judgeEnabled: z.boolean().default(true),
  backend: z.enum(["pi", "jev"]).default("pi"),
  jev: jevSchema.default(() => jevSchema.parse({ credential: {} })),
  thinking: z.enum(thinkingLevels),
  model: z.string().max(200).refine((s) => s === "" || /^[^\s/]+\/[^\s]+$/.test(s)),
  timeoutMs: z.number().int().min(100).max(60000),
  maxOutputTokens: z.number().int().min(128).max(4096),
  errorBehavior: z.enum(["ask", "deny"]),
  policies: z.array(policySchema).max(100),
}).strict().refine((c) => new Set(c.policies.map((p) => p.id)).size === c.policies.length, "Policy IDs must be unique");
export type Config = z.infer<typeof configSchema>;
export const presets: Policy[] = [
  { id: "destructive-git", name: "Destructive Git", conditions: { preset: "git" }, tools: ["bash"] },
  { id: "destructive-files", name: "Destructive files", conditions: { preset: "files" }, tools: ["bash"] },
  { id: "system", name: "System changes", conditions: { preset: "system" }, tools: ["bash", "write", "edit"] },
  { id: "production", name: "Production operations", conditions: { preset: "production" }, tools: ["bash"] },
  { id: "secrets", name: "Secret access", conditions: { preset: "secrets" }, tools: ["bash", "read", "write", "edit"] },
].map((p) => ({ ...p, enabled: true, scope: "both", kind: "structured", action: "Ask" })) as Policy[];
/** Opt-in templates only: never merged into defaults or existing configurations. */
export const operationPresets: Policy[] = [
  { id: "review-mcp", name: "Review MCP operations", tools: ["mcp"], conditions: {} },
  { id: "review-web", name: "Review web operations", tools: ["web-access"], conditions: {} },
].map((p) => ({ ...p, enabled: true, scope: "both", kind: "structured", action: "Ask" })) as Policy[];
export const availablePresets: Policy[] = [...presets, ...operationPresets];
export function defaultConfig(): Config {
  return { version: 1, enabled: false, coverage: coverageSchema.parse({}), judgeEnabled: true, backend: "pi", jev: jevSchema.parse({ credential: {} }), thinking: "off", model: "", timeoutMs: 15000, maxOutputTokens: 1024, errorBehavior: "ask", policies: structuredClone(presets) };
}
export interface ConfigSnapshot { config: Config; policies: Policy[]; revision: string; error?: string; projectStatus: string }
/** Invalid snapshots never qualify for a bypass. Shared by storage-unavailable gates. */
export function bypasses(snapshot: ConfigSnapshot, tool: Tool): boolean {
  return !snapshot.error && (!snapshot.config.enabled || !snapshot.config.coverage[tool]);
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
async function readConfig(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if ((await file.stat()).size > 256000) throw new Error("Config is too large");
    return await file.readFile("utf8");
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return ""; throw e; }
  finally { await file?.close(); }
}
export class ConfigStore {
  readonly globalPath: string;
  readonly projectPath: string;
  constructor(agentDir: string, cwd: string, configDir = ".pi") {
    this.globalPath = join(agentDir, "guardrails.json");
    this.projectPath = join(cwd, configDir, "guardrails.json");
  }
  async load(trusted: boolean): Promise<ConfigSnapshot> {
    let raw = "";
    let config = defaultConfig();
    try {
      raw = await readConfig(this.globalPath);
      config = raw ? configSchema.parse(JSON.parse(raw)) : defaultConfig();
      const policies: Policy[] = config.policies.map((p) => ({ ...p, source: "global" }));
      let projectStatus = trusted ? "No project policies" : "Project policies ignored (untrusted)";
      if (trusted) {
        const local = await readConfig(this.projectPath);
        if (local) {
          const project = z.object({ version: z.literal(1), policies: z.array(policySchema).max(100) }).strict().parse(JSON.parse(local));
          if (project.policies.some((p) => p.action === "Allow" || !p.enabled)) throw new Error("Project policies can only add enabled Ask/Deny restrictions");
          if (new Set(project.policies.map((p) => p.id)).size !== project.policies.length) throw new Error("Duplicate project policy IDs");
          policies.push(...project.policies.map((p) => ({ ...p, id: `project.${p.id}`, source: "project" as const })));
          projectStatus = `${project.policies.length} additive project policies`;
        }
      }
      if (new Set(policies.map((p) => p.id)).size !== policies.length) throw new Error("Policy IDs collide across scopes");
      return { config, policies, revision: hash(raw), projectStatus };
    } catch {
      // Invalid configuration must not turn protection off, including malformed project input.
      return { config: { ...config, enabled: true }, policies: [], revision: hash(raw), error: "Invalid or unreadable guardrails configuration. Repair it outside agent tools.", projectStatus: "Configuration rejected" };
    }
  }
  async save(config: Config, expectedRevision: string, afterRevisionCheck?: () => Promise<void>): Promise<void> {
    const parsed = configSchema.parse(config);
    await mkdir(dirname(this.globalPath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.globalPath}.lock`;
    const lock = await open(lockPath, "wx", 0o600);
    const temp = `${this.globalPath}.${randomUUID()}.tmp`;
    try {
      if (hash(await readConfig(this.globalPath)) !== expectedRevision) throw new Error("Configuration changed elsewhere. Reopen the panel before saving.");
      await afterRevisionCheck?.();
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(parsed, null, 2) + "\n"); await file.sync(); } finally { await file.close(); }
      await rename(temp, this.globalPath);
    } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(lockPath); }
  }
}
