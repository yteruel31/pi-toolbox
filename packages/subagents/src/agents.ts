import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { BackendName, ReasoningEffort } from "./domain.ts";
import { BACKEND_NAMES, REASONING_EFFORTS } from "./domain.ts";

const MAX_AGENT_FILE_BYTES = 1024 * 1024;
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const BACKEND_NAME_SET = new Set<string>(BACKEND_NAMES);
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);

export type AgentScope = "user" | "project";

export interface AgentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly scope: AgentScope;
  readonly filePath: string;
}

export interface AgentRouting {
  readonly harness?: BackendName;
  readonly model?: string;
  readonly thinking?: ReasoningEffort;
}

export interface AgentRoutingFile {
  readonly version: 1;
  readonly agents: Readonly<Record<string, AgentRouting>>;
}

export interface AgentCatalog {
  readonly agents: ReadonlyArray<AgentDefinition>;
  readonly byName: ReadonlyMap<string, AgentDefinition>;
  readonly userRouting: AgentRoutingFile;
  readonly projectRouting: AgentRoutingFile;
  readonly userRoutingPath: string;
  readonly projectRoutingPath?: string;
  /** Project root used to re-check that .pi routing writes stay contained. */
  readonly projectRootPath?: string;
  readonly projectTrusted: boolean;
  readonly warnings: ReadonlyArray<string>;
  readonly routingErrors: Readonly<Partial<Record<AgentScope, string>>>;
}

export interface EffectiveAgentRouting {
  readonly harness: BackendName;
  readonly model?: string;
  readonly thinking?: ReasoningEffort;
  readonly scope?: AgentScope;
}

export interface ResolvedAgentSpawn {
  readonly agent?: AgentDefinition;
  readonly harness: BackendName;
  readonly model?: string;
  readonly thinking?: ReasoningEffort;
}

interface ParsedAgentMarkdown {
  readonly name?: string;
  readonly description?: string;
  readonly systemPrompt: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseAgentMarkdown(content: string): ParsedAgentMarkdown {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { systemPrompt: normalized.trim() };
  }

  const end = normalized.indexOf("\n---", 4);
  if (end < 0) return { systemPrompt: normalized.trim() };

  const frontmatter = normalized.slice(4, end);
  const systemPrompt = normalized.slice(end + 4).replace(/^\n/, "").trim();
  let name: string | undefined;
  let description: string | undefined;

  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = unquote(match[2] ?? "");
    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
  }

  return { name, description, systemPrompt };
}

function discoverMarkdownFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(entryPath);
      }
    }
  };
  visit(root);
  return files;
}

function readAgentDefinitions(
  root: string,
  scope: AgentScope,
  warnings: string[],
): AgentDefinition[] {
  const definitions: AgentDefinition[] = [];
  for (const filePath of discoverMarkdownFiles(root)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_AGENT_FILE_BYTES) {
        warnings.push(
          `Ignored oversized ${scope} agent file "${path.basename(filePath)}".`,
        );
        continue;
      }
      const parsed = parseAgentMarkdown(fs.readFileSync(filePath, "utf8"));
      const name = parsed.name ?? path.basename(filePath, ".md");
      if (!SAFE_AGENT_NAME.test(name)) {
        warnings.push(`Ignored ${scope} agent with invalid name "${name}": ${filePath}`);
        continue;
      }
      definitions.push({
        name,
        ...(parsed.description ? { description: parsed.description } : {}),
        systemPrompt: parsed.systemPrompt,
        scope,
        filePath,
      });
    } catch (error) {
      warnings.push(
        `Could not read ${scope} agent "${path.basename(filePath)}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return definitions;
}

function emptyRoutingFile(): AgentRoutingFile {
  return { version: 1, agents: {} };
}

function projectPathIsSafe(basePath: string, targetPath: string): boolean {
  const base = path.resolve(basePath);
  const target = path.resolve(targetPath);
  const relative = path.relative(base, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  let current = base;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return false;
    }
  }
  return true;
}

function readRoutingWithWarning(
  filePath: string,
  scope: AgentScope,
  warnings: string[],
  routingErrors: Partial<Record<AgentScope, string>>,
): AgentRoutingFile {
  try {
    return readAgentRoutingFile(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    routingErrors[scope] = message;
    warnings.push(`Ignored invalid ${scope} routing file.`);
    return emptyRoutingFile();
  }
}

function normalizeRouting(
  raw: unknown,
  filePath: string,
): AgentRoutingFile {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) {
    throw new Error(`${filePath} must set "version" to 1.`);
  }
  if (!record.agents || typeof record.agents !== "object" || Array.isArray(record.agents)) {
    throw new Error(`${filePath} must contain an "agents" object.`);
  }

  const agents: Record<string, AgentRouting> = {};
  for (const [name, value] of Object.entries(record.agents as Record<string, unknown>)) {
    if (!SAFE_AGENT_NAME.test(name)) {
      throw new Error(`${filePath} contains an invalid agent name "${name}".`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${filePath} contains an invalid routing entry for "${name}".`);
    }
    const assignment = value as Record<string, unknown>;
    const unknownKeys = Object.keys(assignment).filter(
      (key) => key !== "harness" && key !== "model" && key !== "thinking",
    );
    if (unknownKeys.length > 0) {
      throw new Error(
        `${filePath} contains unsupported keys for "${name}": ${unknownKeys.join(", ")}.`,
      );
    }

    const harness = assignment.harness;
    if (harness !== undefined && (typeof harness !== "string" || !BACKEND_NAME_SET.has(harness))) {
      throw new Error(`${filePath} has an invalid harness for "${name}".`);
    }
    const model = assignment.model;
    if (
      model !== undefined &&
      (typeof model !== "string" || !model.trim() || model.length > 256 || CONTROL_CHARACTERS.test(model))
    ) {
      throw new Error(`${filePath} has an invalid model for "${name}".`);
    }
    const thinking = assignment.thinking;
    if (
      thinking !== undefined &&
      (typeof thinking !== "string" || !REASONING_EFFORT_SET.has(thinking))
    ) {
      throw new Error(`${filePath} has an invalid thinking level for "${name}".`);
    }

    agents[name] = {
      ...(typeof harness === "string" ? { harness: harness as BackendName } : {}),
      ...(typeof model === "string" ? { model: model.trim() } : {}),
      ...(typeof thinking === "string" ? { thinking: thinking as ReasoningEffort } : {}),
    };
  }

  return { version: 1, agents };
}

export function readAgentRoutingFile(filePath: string): AgentRoutingFile {
  if (!fs.existsSync(filePath)) return emptyRoutingFile();
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${filePath} must be a regular file, not a symlink.`);
    }
    if (stat.size > MAX_AGENT_FILE_BYTES) {
      throw new Error(`${filePath} exceeds the 1 MiB configuration limit.`);
    }
    return normalizeRouting(JSON.parse(fs.readFileSync(filePath, "utf8")), filePath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Could not parse ${filePath}: ${error.message}`);
    }
    throw error;
  }
}

export function loadAgentCatalog(options: {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly agentDir?: string;
  readonly configDirName?: string;
}): AgentCatalog {
  const requestedAgentDir = options.agentDir ?? getAgentDir();
  const agentDir = fs.existsSync(requestedAgentDir)
    ? fs.realpathSync(requestedAgentDir)
    : path.resolve(requestedAgentDir);
  const configDirName = options.configDirName ?? CONFIG_DIR_NAME;
  const warnings: string[] = [];
  const routingErrors: Partial<Record<AgentScope, string>> = {};
  const userAgentsPath = path.join(agentDir, "agents");
  const userAgentsAllowed = projectPathIsSafe(agentDir, userAgentsPath);
  if (!userAgentsAllowed) {
    warnings.push("Ignored user agent definitions because the agents directory is a symlink.");
  }
  const userDefinitions = userAgentsAllowed
    ? readAgentDefinitions(userAgentsPath, "user", warnings)
    : [];
  const projectBasePath = path.join(options.cwd, configDirName);
  const projectAgentsPath = path.join(projectBasePath, "agents");
  const projectPathAllowed =
    options.projectTrusted &&
    projectPathIsSafe(options.cwd, projectBasePath) &&
    projectPathIsSafe(options.cwd, projectAgentsPath);
  if (options.projectTrusted && !projectPathAllowed) {
    warnings.push(
      `Ignored project subagent configuration because ${configDirName} contains a symlink or escapes the current project.`,
    );
  }
  const projectDefinitions = projectPathAllowed
    ? readAgentDefinitions(projectAgentsPath, "project", warnings)
    : [];

  const byName = new Map<string, AgentDefinition>();
  for (const definition of userDefinitions) {
    if (byName.has(definition.name)) {
      warnings.push(
        `Duplicate user agent "${definition.name}"; using "${path.basename(definition.filePath)}".`,
      );
    }
    byName.set(definition.name, definition);
  }
  for (const definition of projectDefinitions) {
    if (byName.get(definition.name)?.scope === "project") {
      warnings.push(
        `Duplicate project agent "${definition.name}"; using "${path.basename(definition.filePath)}".`,
      );
    }
    byName.set(definition.name, definition);
  }

  const userRoutingPath = path.join(agentDir, "subagents.json");
  const projectRoutingPath = projectPathAllowed
    ? path.join(projectBasePath, "subagents.json")
    : undefined;

  return {
    agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    byName,
    userRouting: readRoutingWithWarning(
      userRoutingPath,
      "user",
      warnings,
      routingErrors,
    ),
    projectRouting: projectRoutingPath
      ? readRoutingWithWarning(
          projectRoutingPath,
          "project",
          warnings,
          routingErrors,
        )
      : emptyRoutingFile(),
    userRoutingPath,
    ...(projectRoutingPath ? { projectRoutingPath, projectRootPath: options.cwd } : {}),
    projectTrusted: projectPathAllowed,
    warnings,
    routingErrors,
  };
}

export function effectiveAgentRouting(
  catalog: AgentCatalog,
  name: string,
): EffectiveAgentRouting {
  const project = catalog.projectRouting.agents[name];
  const user = catalog.userRouting.agents[name];
  const assignment = project ?? user;
  return {
    harness: assignment?.harness ?? "pi",
    ...(assignment?.model ? { model: assignment.model } : {}),
    ...(assignment?.thinking ? { thinking: assignment.thinking } : {}),
    ...(project ? { scope: "project" as const } : user ? { scope: "user" as const } : {}),
  };
}

export function resolveAgentSpawn(
  catalog: AgentCatalog,
  options: {
    readonly agent?: string;
    readonly harness?: BackendName;
    readonly model?: string;
    readonly thinking?: ReasoningEffort;
  },
): ResolvedAgentSpawn {
  const agent = options.agent ? catalog.byName.get(options.agent) : undefined;
  if (options.agent && !agent) {
    throw new Error(
      `Unknown subagent "${options.agent}". Available agents: ${catalog.agents.map((item) => item.name).join(", ") || "none"}.`,
    );
  }

  const mapped = agent ? effectiveAgentRouting(catalog, agent.name) : undefined;
  const harness = options.harness ?? mapped?.harness ?? "pi";
  const keepMappedDetails = options.harness === undefined || options.harness === mapped?.harness;
  const model = options.model ?? (keepMappedDetails ? mapped?.model : undefined);
  const thinking = options.thinking ?? (keepMappedDetails ? mapped?.thinking : undefined);

  return {
    ...(agent ? { agent } : {}),
    harness,
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

function writeJsonAtomic(filePath: string, value: unknown, mode: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode,
    });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The rename normally consumed the temporary path.
    }
  }
}

export function writeAgentRouting(
  catalog: AgentCatalog,
  scope: AgentScope,
  name: string,
  routing: AgentRouting | undefined,
): void {
  if (!SAFE_AGENT_NAME.test(name)) throw new Error(`Invalid agent name "${name}".`);
  const filePath = scope === "user" ? catalog.userRoutingPath : catalog.projectRoutingPath;
  if (!filePath) {
    throw new Error(
      "Project routing is unavailable because the current project is untrusted or its config path is unsafe.",
    );
  }
  if (scope === "project") {
    const basePath = catalog.projectRootPath;
    if (!basePath || !projectPathIsSafe(basePath, filePath)) {
      throw new Error("Project routing path contains a symlink or escapes the current project.");
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!projectPathIsSafe(basePath, filePath)) {
      throw new Error("Project routing path became unsafe before it could be written.");
    }
  }

  let current: AgentRoutingFile;
  try {
    current = readAgentRoutingFile(filePath);
  } catch (error) {
    throw new Error(
      `Cannot update invalid routing file; repair or remove it first: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const agents = { ...current.agents };
  if (!routing || Object.keys(routing).length === 0) {
    delete agents[name];
  } else {
    const validated = normalizeRouting(
      { version: 1, agents: { [name]: routing } },
      filePath,
    );
    agents[name] = validated.agents[name]!;
  }
  writeJsonAtomic(filePath, { version: 1, agents }, 0o600);
}

export function repairAgentRoutingFile(
  catalog: AgentCatalog,
  scope: AgentScope,
): string | undefined {
  const error = catalog.routingErrors[scope];
  if (!error) return undefined;
  const filePath = scope === "user" ? catalog.userRoutingPath : catalog.projectRoutingPath;
  if (!filePath) {
    throw new Error(
      "Project routing is unavailable because the current project is untrusted or its config path is unsafe.",
    );
  }
  if (scope === "project") {
    const basePath = catalog.projectRootPath;
    if (!basePath || !projectPathIsSafe(basePath, filePath)) {
      throw new Error("Project routing path contains a symlink or escapes the current project.");
    }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (
    scope === "project" &&
    (!catalog.projectRootPath ||
      !projectPathIsSafe(catalog.projectRootPath, filePath))
  ) {
    throw new Error("Project routing path became unsafe before it could be repaired.");
  }
  let exists = false;
  try {
    fs.lstatSync(filePath);
    exists = true;
  } catch (readError) {
    if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
  }
  const backupPath = `${filePath}.invalid-${Date.now()}-${randomUUID()}`;
  if (exists) fs.renameSync(filePath, backupPath);
  writeJsonAtomic(filePath, emptyRoutingFile(), 0o600);
  return exists ? backupPath : undefined;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function buildAgentCatalogPrompt(catalog: AgentCatalog): string | undefined {
  if (catalog.agents.length === 0) return undefined;
  const entries = catalog.agents.slice(0, 100).map((agent) => {
    const routing = effectiveAgentRouting(catalog, agent.name);
    const description = agent.description?.replace(/\s+/g, " ").trim().slice(0, 240);
    return `  <agent name="${xmlEscape(agent.name)}" scope="${agent.scope}" harness="${routing.harness}" model="${xmlEscape(routing.model ?? "default")}" thinking="${routing.thinking ?? "default"}"${description ? ` description="${xmlEscape(description)}"` : ""} />`;
  });
  const omitted = catalog.agents.length - entries.length;
  return [
    "Configured subagent profiles are listed below. When a task matches a profile, pass its exact name in subagent_spawn.agent; its routing and system prompt are resolved automatically. Explicit harness/model/reasoning_effort arguments override the profile mapping.",
    "<subagent-profiles>",
    ...entries,
    ...(omitted > 0 ? [`  <!-- ${omitted} additional profiles omitted -->`] : []),
    "</subagent-profiles>",
  ].join("\n");
}
