import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONFIG_DIR_NAME,
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { BackendName, ReasoningEffort } from "./domain.ts";
import { BACKEND_NAMES, REASONING_EFFORTS } from "./domain.ts";

const MAX_AGENT_FILE_BYTES = 1024 * 1024;
const MAX_PACKAGE_MANIFEST_BYTES = 1024 * 1024;
const MAX_PACKAGE_AGENT_DIRECTORIES = 100;
const MAX_PACKAGE_AGENT_PATH_LENGTH = 1024;
const MAX_PACKAGE_SCAN_DEPTH = 20;
const MAX_PACKAGE_SCAN_DIRECTORIES = 1000;
const MAX_PACKAGE_SCAN_ENTRIES = 5000;
const MAX_PACKAGE_AGENT_FILES = 500;
const MAX_PACKAGE_AGENT_TOTAL_BYTES = 16 * 1024 * 1024;
const SAFE_AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const BACKEND_NAME_SET = new Set<string>(BACKEND_NAMES);
const REASONING_EFFORT_SET = new Set<string>(REASONING_EFFORTS);

export type AgentScope = "user" | "project";
export type AgentDefinitionSource = AgentScope | "package";

export interface AgentDefinition {
  readonly name: string;
  readonly description?: string;
  readonly systemPrompt: string;
  readonly scope: AgentDefinitionSource;
  readonly filePath: string;
  readonly packageSource?: string;
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

interface AgentDiscoveryBudget {
  directories: number;
  entries: number;
  files: number;
  bytes: number;
  warned: Set<string>;
}

function warnPackageBudget(
  budget: AgentDiscoveryBudget,
  warnings: string[],
  limit: string,
  message: string,
) {
  if (budget.warned.has(limit)) return;
  budget.warned.add(limit);
  warnings.push(message);
}

function discoverMarkdownFiles(
  root: string,
  warnings: string[],
  budget?: AgentDiscoveryBudget,
): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string, depth: number) => {
    if (budget) {
      if (
        budget.warned.has("directories") ||
        budget.warned.has("entries") ||
        budget.warned.has("files") ||
        budget.warned.has("bytes")
      ) return;
      if (depth > MAX_PACKAGE_SCAN_DEPTH) {
        warnPackageBudget(
          budget,
          warnings,
          "depth",
          `Stopped package agent discovery beyond ${MAX_PACKAGE_SCAN_DEPTH} directory levels.`,
        );
        return;
      }
      if (budget.directories >= MAX_PACKAGE_SCAN_DIRECTORIES) {
        warnPackageBudget(
          budget,
          warnings,
          "directories",
          `Stopped package agent discovery after ${MAX_PACKAGE_SCAN_DIRECTORIES} directories.`,
        );
        return;
      }
      budget.directories += 1;
    }

    let entries: fs.Dirent[];
    if (budget) {
      entries = [];
      const handle = fs.opendirSync(directory);
      try {
        let entry: fs.Dirent | null;
        while ((entry = handle.readSync()) !== null) {
          if (budget.entries >= MAX_PACKAGE_SCAN_ENTRIES) {
            warnPackageBudget(
              budget,
              warnings,
              "entries",
              `Stopped package agent discovery after ${MAX_PACKAGE_SCAN_ENTRIES} directory entries.`,
            );
            break;
          }
          budget.entries += 1;
          entries.push(entry);
        }
      } finally {
        handle.closeSync();
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
    } else {
      entries = fs
        .readdirSync(directory, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(entryPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (budget && budget.files >= MAX_PACKAGE_AGENT_FILES) {
          warnPackageBudget(
            budget,
            warnings,
            "files",
            `Stopped package agent discovery after ${MAX_PACKAGE_AGENT_FILES} Markdown files.`,
          );
          return;
        }
        if (budget) budget.files += 1;
        files.push(entryPath);
      }
    }
  };
  visit(root, 0);
  return files;
}

function readAgentDefinitions(
  root: string,
  scope: AgentDefinitionSource,
  warnings: string[],
  options: { budget?: AgentDiscoveryBudget; packageSource?: string } = {},
): AgentDefinition[] {
  const definitions: AgentDefinition[] = [];
  for (const filePath of discoverMarkdownFiles(root, warnings, options.budget)) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_AGENT_FILE_BYTES) {
        warnings.push(
          `Ignored oversized ${scope} agent file "${path.basename(filePath)}".`,
        );
        continue;
      }
      if (
        options.budget &&
        options.budget.bytes + stat.size > MAX_PACKAGE_AGENT_TOTAL_BYTES
      ) {
        warnPackageBudget(
          options.budget,
          warnings,
          "bytes",
          `Stopped package agent discovery after ${MAX_PACKAGE_AGENT_TOTAL_BYTES} bytes of Markdown.`,
        );
        break;
      }
      if (options.budget) options.budget.bytes += stat.size;
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
        ...(options.packageSource ? { packageSource: options.packageSource } : {}),
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

function readPackageManifest(packageRoot: string, warnings: string[]): unknown {
  const manifestPath = path.join(packageRoot, "package.json");
  if (!fs.existsSync(manifestPath)) return undefined;

  try {
    const stat = fs.lstatSync(manifestPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      warnings.push(
        `Ignored package agent manifest in "${path.basename(packageRoot)}" because package.json is not a regular file.`,
      );
      return undefined;
    }
    if (stat.size > MAX_PACKAGE_MANIFEST_BYTES) {
      warnings.push(
        `Ignored oversized package agent manifest in "${path.basename(packageRoot)}".`,
      );
      return undefined;
    }
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    warnings.push(
      `Could not read package agent manifest in "${path.basename(packageRoot)}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function packageAgentManifestEntries(
  manifest: unknown,
  packageRoot: string,
  warnings: string[],
): string[] {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return [];
  const record = manifest as Record<string, unknown>;
  const declarations: Array<{ key: string; value: unknown }> = [];
  const addDeclaration = (key: string, subagents: unknown) => {
    declarations.push({
      key,
      value:
        subagents && typeof subagents === "object" && !Array.isArray(subagents)
          ? (subagents as Record<string, unknown>).agents
          : subagents,
    });
  };

  if (record.pi && typeof record.pi === "object" && !Array.isArray(record.pi)) {
    const subagents = (record.pi as Record<string, unknown>).subagents;
    if (subagents !== undefined) addDeclaration("pi.subagents.agents", subagents);
  }
  if (record["pi-subagents"] !== undefined) {
    addDeclaration("pi-subagents.agents", record["pi-subagents"]);
  }

  const entries: string[] = [];
  for (const declaration of declarations) {
    if (!Array.isArray(declaration.value)) {
      warnings.push(
        `Ignored invalid ${declaration.key} in package "${path.basename(packageRoot)}"; expected an array of relative directory paths.`,
      );
      continue;
    }
    if (declaration.value.length > MAX_PACKAGE_AGENT_DIRECTORIES) {
      warnings.push(
        `Ignored ${declaration.key} in package "${path.basename(packageRoot)}" because it declares more than ${MAX_PACKAGE_AGENT_DIRECTORIES} directories.`,
      );
      continue;
    }
    const invalid = declaration.value.some(
      (entry) =>
        typeof entry !== "string" ||
        entry.length === 0 ||
        entry.length > MAX_PACKAGE_AGENT_PATH_LENGTH ||
        entry.includes("\0"),
    );
    if (invalid) {
      warnings.push(
        `Ignored invalid ${declaration.key} in package "${path.basename(packageRoot)}"; expected non-empty relative directory paths.`,
      );
      continue;
    }
    entries.push(...(declaration.value as string[]));
  }
  return entries;
}

function packageAgentDefinitions(
  packageRoot: string,
  packageSource: string,
  warnings: string[],
): AgentDefinition[] {
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync(packageRoot);
  } catch {
    return [];
  }

  const manifest = readPackageManifest(canonicalRoot, warnings);
  const entries = packageAgentManifestEntries(manifest, canonicalRoot, warnings);
  const seenDirectories = new Set<string>();
  const definitions: AgentDefinition[] = [];
  const budget: AgentDiscoveryBudget = {
    directories: 0,
    entries: 0,
    files: 0,
    bytes: 0,
    warned: new Set(),
  };

  for (const entry of entries) {
    const target = path.resolve(canonicalRoot, entry);
    if (
      path.isAbsolute(entry) ||
      !projectPathIsSafe(canonicalRoot, target) ||
      seenDirectories.has(target)
    ) {
      if (!seenDirectories.has(target)) {
        warnings.push(
          `Ignored unsafe package agent directory "${entry}" in "${path.basename(canonicalRoot)}".`,
        );
      }
      continue;
    }
    seenDirectories.add(target);
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        warnings.push(
          `Ignored package agent path "${entry}" in "${path.basename(canonicalRoot)}" because it is not a regular directory.`,
        );
        continue;
      }
    } catch {
      warnings.push(
        `Ignored missing package agent directory "${entry}" in "${path.basename(canonicalRoot)}".`,
      );
      continue;
    }
    definitions.push(
      ...readAgentDefinitions(target, "package", warnings, { budget, packageSource }),
    );
  }

  return definitions;
}

function stripPackageRef(repoPath: string): string {
  const separators = [repoPath.indexOf("@"), repoPath.indexOf("#")]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  return separators[0] === undefined ? repoPath : repoPath.slice(0, separators[0]);
}

function gitPackageIdentity(source: string): string | undefined {
  const trimmed = source.trim();
  const hasGitPrefix = trimmed.startsWith("git:");
  const spec = hasGitPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasGitPrefix && !/^(https?|ssh|git):\/\//i.test(spec)) return undefined;

  const scpLike = spec.match(/^git@([^:]+):(.+)$/);
  let host: string;
  let repoPath: string;
  if (scpLike) {
    host = scpLike[1] ?? "";
    repoPath = scpLike[2] ?? "";
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec)) {
    try {
      const url = new URL(spec);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  } else {
    const slashIndex = spec.indexOf("/");
    if (slashIndex < 0) return undefined;
    host = spec.slice(0, slashIndex);
    repoPath = spec.slice(slashIndex + 1);
  }

  const normalizedPath = stripPackageRef(repoPath)
    .replace(/\.git$/, "")
    .replace(/^\/+/, "");
  if (!host || !normalizedPath || normalizedPath.split("/").length < 2) return undefined;
  return `git:${host.toLowerCase()}/${normalizedPath}`;
}

function configuredPackageIdentity(
  source: string,
  scope: AgentScope,
  cwd: string,
  agentDir: string,
  installedPath?: string,
): string {
  if (source.startsWith("npm:")) {
    const spec = source.slice(4).trim();
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@.+)?$/);
    return `npm:${match?.[1] ?? spec}`;
  }

  const baseDir = scope === "user" ? agentDir : path.join(cwd, CONFIG_DIR_NAME);
  const isGitSource = source.startsWith("git:") || /^(https?|ssh|git):\/\//i.test(source);
  if (installedPath && isGitSource) {
    const gitRoot = path.resolve(baseDir, "git");
    const relativePath = path.relative(gitRoot, path.resolve(installedPath));
    if (
      relativePath &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath)
    ) {
      return `git:${relativePath.split(path.sep).join("/")}`;
    }
  }

  const gitIdentity = gitPackageIdentity(source);
  if (gitIdentity) return gitIdentity;

  const localSource = source.startsWith("file:") ? source.slice(5) : source;
  return `local:${path.resolve(baseDir, localSource)}`;
}

function configuredPackageAgentDefinitions(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  warnings: string[];
}): AgentDefinition[] {
  try {
    const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
      projectTrusted: options.projectTrusted,
    });
    const packageManager = new DefaultPackageManager({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
    });
    const autoloadByPackage = new Map<string, boolean>();
    const rememberAutoload = (scope: AgentScope, packages: unknown[]) => {
      for (const entry of packages) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const source = (entry as Record<string, unknown>).source;
        if (typeof source !== "string") continue;
        autoloadByPackage.set(
          `${scope}\0${source}`,
          (entry as Record<string, unknown>).autoload !== false,
        );
      }
    };
    rememberAutoload("user", settingsManager.getGlobalSettings().packages ?? []);
    if (options.projectTrusted) {
      rememberAutoload("project", settingsManager.getProjectSettings().packages ?? []);
    }

    const effectivePackages = new Map<
      string,
      {
        source: string;
        installedPath?: string;
        autoload: boolean;
      }
    >();
    for (const configured of packageManager.listConfiguredPackages()) {
      if (configured.scope === "project" && !options.projectTrusted) continue;
      const identity = configuredPackageIdentity(
        configured.source,
        configured.scope,
        options.cwd,
        options.agentDir,
        configured.installedPath,
      );
      effectivePackages.delete(identity);
      effectivePackages.set(identity, {
        source: identity,
        ...(configured.installedPath ? { installedPath: configured.installedPath } : {}),
        autoload:
          autoloadByPackage.get(`${configured.scope}\0${configured.source}`) !== false,
      });
    }

    const seenRoots = new Set<string>();
    const definitions: AgentDefinition[] = [];
    for (const configured of effectivePackages.values()) {
      if (!configured.autoload || !configured.installedPath) continue;
      let canonicalRoot: string;
      try {
        canonicalRoot = fs.realpathSync(configured.installedPath);
      } catch {
        continue;
      }
      if (seenRoots.has(canonicalRoot)) continue;
      seenRoots.add(canonicalRoot);
      definitions.push(
        ...packageAgentDefinitions(canonicalRoot, configured.source, options.warnings),
      );
    }
    return definitions;
  } catch (error) {
    options.warnings.push(
      `Could not discover package agents: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
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
  const packageDefinitions = configuredPackageAgentDefinitions({
    cwd: options.cwd,
    agentDir,
    projectTrusted: options.projectTrusted,
    warnings,
  });
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
  for (const definition of packageDefinitions) {
    const existing = byName.get(definition.name);
    if (existing) {
      warnings.push(
        `Duplicate package agent "${definition.name}" from "${existing.packageSource ?? "unknown package"}" and "${definition.packageSource ?? "unknown package"}"; using the latter.`,
      );
    }
    byName.set(definition.name, definition);
  }
  for (const definition of userDefinitions) {
    if (byName.get(definition.name)?.scope === "user") {
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
    return `  <agent name="${xmlEscape(agent.name)}" scope="${agent.scope}"${agent.packageSource ? ` package="${xmlEscape(agent.packageSource)}"` : ""} harness="${routing.harness}" model="${xmlEscape(routing.model ?? "default")}" thinking="${routing.thinking ?? "default"}"${description ? ` description="${xmlEscape(description)}"` : ""} />`;
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
