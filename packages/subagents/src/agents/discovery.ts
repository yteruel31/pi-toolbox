import { homedir } from "node:os";
import * as path from "node:path";
import { truncateText } from "../shared/truncate.js";
import { parseAgentMarkdown } from "./frontmatter.js";
import { isNotFound, nodeFileSystem, type AgentFileSystem } from "./fs-seam.js";
import {
  AGENT_NAME_PATTERN,
  AGENT_SKILL_NAME_PATTERN,
  AGENT_TOOL_NAME_PATTERN,
  MAX_AGENT_DESCRIPTION_CHARS,
  MAX_AGENT_FILE_BYTES,
  MAX_AGENT_MODEL_CHARS,
  MAX_AGENT_NAME_CHARS,
  MAX_AGENT_SKILL_NAME_CHARS,
  MAX_AGENT_SKILLS,
  MAX_AGENT_TOOL_NAME_CHARS,
  MAX_AGENT_TOOLS,
  MAX_MANIFEST_AGENT_DIRS,
  MAX_PACKAGE_JSON_BYTES,
  MAX_SCAN_DEPTH,
  MAX_SCAN_DIRECTORIES,
  MAX_SCAN_FILES,
  MAX_SCAN_TOTAL_BYTES,
  MAX_SYSTEM_PROMPT_CHARS,
} from "./limits.js";
import { normalizePackageSettings } from "./package-settings.js";
import type {
  AgentCatalog,
  AgentDefinition,
  AgentDiscovery,
  AgentDiscoveryOptions,
  AgentScope,
  InstalledAgentPackage,
  PackageSettingInput,
} from "./types.js";
import { WarningCollector } from "./warnings.js";

const HARNESSES = new Set(["pi", "claude"]);
const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export interface FileAgentDiscoveryOptions {
  agentDir?: string;
  packages?: readonly InstalledAgentPackage[];
  packageSettings?: {
    user?: readonly PackageSettingInput[];
    project?: readonly PackageSettingInput[];
  };
  fs?: AgentFileSystem;
}

interface ScanBudget {
  directories: number;
  files: number;
  bytes: number;
}

interface ScanSource {
  scope: AgentScope;
  packageName?: string;
}

interface PackageManifest {
  name?: string;
  agentDirectories: unknown[];
}

/** Filesystem-backed, on-demand discovery for package, user, and project agents. */
export class FileAgentDiscovery implements AgentDiscovery {
  private readonly fs: AgentFileSystem;
  private readonly agentDir: string;
  private readonly packages: readonly InstalledAgentPackage[];
  private readonly packageSettings: FileAgentDiscoveryOptions["packageSettings"];

  constructor(options: FileAgentDiscoveryOptions = {}) {
    this.fs = options.fs ?? nodeFileSystem;
    this.agentDir = path.resolve(options.agentDir ?? path.join(homedir(), ".pi", "agent"));
    this.packages = options.packages ?? [];
    this.packageSettings = options.packageSettings;
  }

  async discover(options: AgentDiscoveryOptions): Promise<AgentCatalog> {
    const warnings = new WarningCollector();
    const budget: ScanBudget = { directories: 0, files: 0, bytes: 0 };
    const agents = new Map<string, AgentDefinition>();

    for (const pkg of this.effectivePackages(options.projectTrusted)) {
      await this.scanPackage(pkg, agents, budget, warnings);
    }

    await this.scanRoot(
      path.join(this.agentDir, "agents"),
      { scope: "user" },
      agents,
      budget,
      warnings,
      true,
    );

    if (options.projectTrusted) {
      const projectConfig = path.join(path.resolve(options.cwd), ".pi");
      const projectAgents = path.join(projectConfig, "agents");
      if (await this.isSafeDirectory(projectConfig, warnings, true)) {
        await this.scanRoot(
          projectAgents,
          { scope: "project" },
          agents,
          budget,
          warnings,
          true,
        );
      }
    }

    return {
      agents: [...agents.values()].sort((left, right) =>
        left.name.localeCompare(right.name) || left.source.path.localeCompare(right.source.path),
      ),
      warnings: warnings.list(),
    };
  }

  private effectivePackages(projectTrusted: boolean): InstalledAgentPackage[] {
    if (this.packageSettings) {
      const settings = normalizePackageSettings({
        user: this.packageSettings.user,
        project: this.packageSettings.project,
        projectTrusted,
      });
      const installations = new Map<string, InstalledAgentPackage>();
      for (const pkg of this.packages) installations.set(pkg.source, pkg);
      return settings.flatMap((setting) => {
        const pkg = installations.get(setting.source);
        if (!pkg || setting.autoload === false || pkg.autoload === false) return [];
        return [{ ...pkg, scope: setting.scope }];
      });
    }

    const ordered = new Map<string, InstalledAgentPackage>();
    for (const pkg of this.packages) {
      if (pkg.scope === "project" && !projectTrusted) continue;
      ordered.delete(pkg.source);
      ordered.set(pkg.source, pkg);
    }
    return [...ordered.values()].filter((pkg) => pkg.autoload !== false);
  }

  private async scanPackage(
    pkg: InstalledAgentPackage,
    agents: Map<string, AgentDefinition>,
    budget: ScanBudget,
    warnings: WarningCollector,
  ): Promise<void> {
    const suppliedRoot = path.resolve(pkg.root);
    const root = await this.safeRoot(suppliedRoot, warnings, `package ${pkg.source}`);
    if (!root) return;

    const manifest = await this.readPackageManifest(root, pkg, warnings);
    if (!manifest) return;
    const packageName = truncateText(
      manifest.name ?? pkg.name ?? pkg.source,
      MAX_AGENT_DESCRIPTION_CHARS,
    );
    const declarations = manifest.agentDirectories;
    if (declarations.length > MAX_MANIFEST_AGENT_DIRS) {
      warnings.add(
        `Package ${packageName} declares ${declarations.length} agent directories; only the first ${MAX_MANIFEST_AGENT_DIRS} are scanned`,
      );
    }

    for (const declaration of declarations.slice(0, MAX_MANIFEST_AGENT_DIRS)) {
      if (typeof declaration !== "string" || !declaration.trim()) {
        warnings.add(`Package ${packageName} has an invalid agent directory declaration`);
        continue;
      }
      const scanPath = path.resolve(root, declaration);
      if (!isContained(root, scanPath)) {
        warnings.add(`Package ${packageName} agent path escapes its package root: ${declaration}`);
        continue;
      }
      if (!(await this.pathComponentsAreSafe(root, scanPath, warnings, packageName))) continue;
      const realScanPath = await this.realpathIfSafe(scanPath, warnings, packageName);
      if (!realScanPath || !isContained(root, realScanPath)) {
        if (realScanPath) {
          warnings.add(`Package ${packageName} agent path resolves outside its package root: ${declaration}`);
        }
        continue;
      }
      await this.scanRoot(
        scanPath,
        { scope: "package", packageName },
        agents,
        budget,
        warnings,
        false,
        root,
      );
    }
  }

  private async readPackageManifest(
    root: string,
    pkg: InstalledAgentPackage,
    warnings: WarningCollector,
  ): Promise<PackageManifest | undefined> {
    const manifestPath = path.join(root, "package.json");
    let stats;
    try {
      stats = await this.fs.lstat(manifestPath);
    } catch (error) {
      warnings.add(`Cannot read package manifest for ${pkg.source}: ${errorCode(error)}`);
      return undefined;
    }
    if (stats.isSymbolicLink || !stats.isFile) {
      warnings.add(`Package manifest for ${pkg.source} is not a regular file`);
      return undefined;
    }
    if (stats.size > MAX_PACKAGE_JSON_BYTES) {
      warnings.add(`Package manifest for ${pkg.source} exceeds the size limit`);
      return undefined;
    }

    let text: string;
    try {
      text = await this.fs.readFile(manifestPath);
    } catch (error) {
      warnings.add(`Cannot read package manifest for ${pkg.source}: ${errorCode(error)}`);
      return undefined;
    }
    if (Buffer.byteLength(text) > MAX_PACKAGE_JSON_BYTES) {
      warnings.add(`Package manifest for ${pkg.source} exceeds the size limit`);
      return undefined;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      warnings.add(`Package manifest for ${pkg.source} is invalid JSON`);
      return undefined;
    }
    if (!isRecord(raw)) {
      warnings.add(`Package manifest for ${pkg.source} must be an object`);
      return undefined;
    }

    const primary = isRecord(raw.pi) && isRecord(raw.pi.subagents)
      ? raw.pi.subagents.agents
      : undefined;
    const compatibility = isRecord(raw["pi-subagents"])
      ? raw["pi-subagents"].agents
      : raw["pi-subagents.agents"];
    const declaration = primary ?? compatibility;
    if (declaration === undefined) return undefined;
    const agentDirectories = Array.isArray(declaration) ? declaration : [declaration];
    const name = typeof raw.name === "string" && raw.name.trim()
      ? truncateText(raw.name.trim(), MAX_AGENT_DESCRIPTION_CHARS)
      : undefined;
    return name ? { name, agentDirectories } : { agentDirectories };
  }

  private async scanRoot(
    rootPath: string,
    source: ScanSource,
    agents: Map<string, AgentDefinition>,
    budget: ScanBudget,
    warnings: WarningCollector,
    missingIsNormal: boolean,
    containmentRoot?: string,
  ): Promise<void> {
    const root = await this.safeRoot(rootPath, warnings, `${source.scope} agents`, missingIsNormal);
    if (!root) return;
    const boundary = containmentRoot ?? root;
    if (!isContained(boundary, root)) {
      warnings.add(`Agent root resolves outside its allowed boundary: ${rootPath}`);
      return;
    }

    const visit = async (directory: string, depth: number): Promise<void> => {
      if (budget.directories >= MAX_SCAN_DIRECTORIES) {
        warnings.add(`Agent directory scan stopped at the ${MAX_SCAN_DIRECTORIES}-directory limit`);
        return;
      }
      budget.directories++;

      let names: string[];
      try {
        names = (await this.fs.readdir(directory)).sort((a, b) => a.localeCompare(b));
      } catch (error) {
        warnings.add(`Cannot list agent directory ${directory}: ${errorCode(error)}`);
        return;
      }

      for (const name of names) {
        const candidate = path.join(directory, name);
        let stats;
        try {
          stats = await this.fs.lstat(candidate);
        } catch (error) {
          warnings.add(`Cannot inspect agent path ${candidate}: ${errorCode(error)}`);
          continue;
        }
        if (stats.isSymbolicLink) {
          warnings.add(`Skipped symlink in agent scan: ${candidate}`);
          continue;
        }
        const realCandidate = await this.realpathIfSafe(candidate, warnings, "agent scan");
        if (!realCandidate || !isContained(boundary, realCandidate)) {
          if (realCandidate) warnings.add(`Skipped agent path outside its allowed boundary: ${candidate}`);
          continue;
        }
        if (stats.isDirectory) {
          if (depth >= MAX_SCAN_DEPTH) {
            warnings.add(`Skipped agent directory beyond depth ${MAX_SCAN_DEPTH}: ${candidate}`);
            continue;
          }
          await visit(candidate, depth + 1);
          continue;
        }
        if (!stats.isFile || !name.toLowerCase().endsWith(".md")) continue;
        await this.readAgent(candidate, stats.size, source, agents, budget, warnings);
      }
    };

    await visit(rootPath, 0);
  }

  private async readAgent(
    filePath: string,
    reportedBytes: number,
    source: ScanSource,
    agents: Map<string, AgentDefinition>,
    budget: ScanBudget,
    warnings: WarningCollector,
  ): Promise<void> {
    if (budget.files >= MAX_SCAN_FILES) {
      warnings.add(`Agent file scan stopped at the ${MAX_SCAN_FILES}-file limit`);
      return;
    }
    if (reportedBytes > MAX_AGENT_FILE_BYTES) {
      warnings.add(`Skipped oversized agent file: ${filePath}`);
      return;
    }
    if (budget.bytes + reportedBytes > MAX_SCAN_TOTAL_BYTES) {
      warnings.add(`Agent file scan stopped at the aggregate byte limit`);
      return;
    }

    budget.files++;
    let text: string;
    try {
      text = await this.fs.readFile(filePath);
    } catch (error) {
      warnings.add(`Cannot read agent file ${filePath}: ${errorCode(error)}`);
      return;
    }
    const bytes = Buffer.byteLength(text);
    if (bytes > MAX_AGENT_FILE_BYTES) {
      warnings.add(`Skipped oversized agent file: ${filePath}`);
      return;
    }
    if (budget.bytes + bytes > MAX_SCAN_TOTAL_BYTES) {
      warnings.add(`Agent file scan stopped at the aggregate byte limit`);
      return;
    }
    budget.bytes += bytes;

    const parsed = parseAgentMarkdown(text);
    if (!parsed.ok) {
      warnings.add(`Skipped invalid agent file ${filePath}: ${parsed.reason}`);
      return;
    }
    const validation = validateAgent(parsed.parsed.frontmatter, parsed.parsed.body);
    if (!validation.ok) {
      warnings.add(`Skipped invalid agent file ${filePath}: ${validation.reason}`);
      return;
    }

    const realPath = await this.realpathIfSafe(filePath, warnings, "agent file");
    if (!realPath) return;
    const definition: AgentDefinition = {
      ...validation.agent,
      source: {
        scope: source.scope,
        path: realPath,
        ...(source.packageName ? { packageName: source.packageName } : {}),
      },
    };
    const previous = agents.get(definition.name);
    if (previous?.source.scope === "package" && source.scope === "package") {
      warnings.add(
        `Package agent collision for '${definition.name}': ${describeSource(previous)} replaced by ${describeSource(definition)}`,
      );
    }
    agents.set(definition.name, definition);
  }

  private async safeRoot(
    rootPath: string,
    warnings: WarningCollector,
    label: string,
    missingIsNormal = false,
  ): Promise<string | undefined> {
    let stats;
    try {
      stats = await this.fs.lstat(rootPath);
    } catch (error) {
      if (!missingIsNormal || !isNotFound(error)) {
        warnings.add(`Cannot inspect ${label}: ${errorCode(error)}`);
      }
      return undefined;
    }
    if (stats.isSymbolicLink) {
      warnings.add(`Refused symlinked ${label}: ${rootPath}`);
      return undefined;
    }
    if (!stats.isDirectory) {
      warnings.add(`Expected ${label} to be a directory: ${rootPath}`);
      return undefined;
    }
    const real = await this.realpathIfSafe(rootPath, warnings, label);
    if (real && real !== path.resolve(rootPath)) {
      warnings.add(`Refused ${label} because its path crosses a symlink: ${rootPath}`);
      return undefined;
    }
    return real;
  }

  private async isSafeDirectory(
    directory: string,
    warnings: WarningCollector,
    missingIsNormal: boolean,
  ): Promise<boolean> {
    return Boolean(await this.safeRoot(directory, warnings, "project .pi directory", missingIsNormal));
  }

  private async pathComponentsAreSafe(
    root: string,
    target: string,
    warnings: WarningCollector,
    packageName: string,
  ): Promise<boolean> {
    const relative = path.relative(root, target);
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        const stats = await this.fs.lstat(current);
        if (stats.isSymbolicLink) {
          warnings.add(`Package ${packageName} agent path crosses a symlink: ${current}`);
          return false;
        }
      } catch (error) {
        if (!isNotFound(error)) {
          warnings.add(`Cannot inspect package ${packageName} agent path: ${errorCode(error)}`);
        }
        return false;
      }
    }
    return true;
  }

  private async realpathIfSafe(
    value: string,
    warnings: WarningCollector,
    label: string,
  ): Promise<string | undefined> {
    try {
      return await this.fs.realpath(value);
    } catch (error) {
      if (!isNotFound(error)) warnings.add(`Cannot resolve ${label}: ${errorCode(error)}`);
      return undefined;
    }
  }
}

type AgentValidation =
  | { ok: true; agent: Omit<AgentDefinition, "source"> }
  | { ok: false; reason: string };

function validateAgent(
  frontmatter: Record<string, unknown>,
  body: string,
): AgentValidation {
  const name = scalarValue(frontmatter.name)?.trim() ?? "";
  if (!name) return { ok: false, reason: "missing name" };
  if (name.length > MAX_AGENT_NAME_CHARS || !AGENT_NAME_PATTERN.test(name)) {
    return { ok: false, reason: "name is too long or contains unsupported characters" };
  }
  const description = scalarValue(frontmatter.description)?.trim() ?? "";
  if (!description) return { ok: false, reason: "missing description" };
  if (description.length > MAX_AGENT_DESCRIPTION_CHARS) {
    return { ok: false, reason: "description exceeds the length limit" };
  }
  if (body.length > MAX_SYSTEM_PROMPT_CHARS) {
    return { ok: false, reason: "system prompt exceeds the length limit" };
  }

  let tools: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(frontmatter, "tools")) {
    const parsedTools = stringListValue(frontmatter.tools);
    if (!parsedTools) {
      return { ok: false, reason: "tools allowlist must contain only names" };
    }
    if (parsedTools.length === 0 || parsedTools.every((tool) => !tool)) {
      return { ok: false, reason: "tools allowlist is empty" };
    }
    if (parsedTools.some((tool) => !tool)) {
      return { ok: false, reason: "tools allowlist contains an empty name" };
    }
    if (parsedTools.length > MAX_AGENT_TOOLS) {
      return { ok: false, reason: "tools allowlist exceeds the count limit" };
    }
    if (parsedTools.some((tool) =>
      tool.length > MAX_AGENT_TOOL_NAME_CHARS || !AGENT_TOOL_NAME_PATTERN.test(tool)
    )) {
      return { ok: false, reason: "tools allowlist contains an invalid name" };
    }
    if (new Set(parsedTools).size !== parsedTools.length) {
      return { ok: false, reason: "tools allowlist contains a duplicate name" };
    }
    tools = parsedTools;
  }

  let skills: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(frontmatter, "skills")) {
    const parsedSkills = stringListValue(frontmatter.skills);
    if (!parsedSkills) {
      return { ok: false, reason: "skills list must contain only names" };
    }
    if (parsedSkills.some((skill) => !skill)) {
      return { ok: false, reason: "skills list contains an empty name" };
    }
    if (parsedSkills.length > MAX_AGENT_SKILLS) {
      return { ok: false, reason: "skills list exceeds the count limit" };
    }
    if (parsedSkills.some((skill) =>
      skill.length > MAX_AGENT_SKILL_NAME_CHARS || !AGENT_SKILL_NAME_PATTERN.test(skill)
    )) {
      return { ok: false, reason: "skills list contains an invalid name" };
    }
    if (new Set(parsedSkills).size !== parsedSkills.length) {
      return { ok: false, reason: "skills list contains a duplicate name" };
    }
    skills = parsedSkills;
  }

  const defaults: AgentDefinition["defaults"] = {};
  const harness = scalarValue(frontmatter.harness)?.trim();
  if (harness) {
    if (!HARNESSES.has(harness)) return { ok: false, reason: "invalid harness default" };
    defaults.harness = harness as AgentDefinition["defaults"]["harness"];
  }
  const model = scalarValue(frontmatter.model)?.trim();
  if (model) {
    if (model.length > MAX_AGENT_MODEL_CHARS) return { ok: false, reason: "model exceeds the length limit" };
    defaults.model = model;
  }
  const thinking = scalarValue(frontmatter.thinking)?.trim();
  if (thinking) {
    if (!THINKING_LEVELS.has(thinking)) return { ok: false, reason: "invalid thinking default" };
    defaults.thinking = thinking as AgentDefinition["defaults"]["thinking"];
  }

  return {
    ok: true,
    agent: {
      name,
      description,
      systemPrompt: body,
      ...(tools ? { tools } : {}),
      ...(skills ? { skills } : {}),
      defaults,
    },
  };
}

function scalarValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringListValue(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim());
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value.map((item) => item.trim());
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "filesystem error";
}

function describeSource(agent: AgentDefinition): string {
  return agent.source.packageName
    ? `${agent.source.packageName} (${agent.source.path})`
    : agent.source.path;
}
