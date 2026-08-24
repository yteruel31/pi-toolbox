import { open, lstat, opendir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  parseFrontmatter,
  stripFrontmatter,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_SKILL_NAME_PATTERN,
  MAX_AGENT_SKILL_NAME_CHARS,
  MAX_AGENT_SKILLS,
} from "./limits.js";

/** Maximum bytes read from one preloaded SKILL.md. */
export const MAX_PRELOADED_SKILL_FILE_BYTES = 128 * 1024;
/** Maximum formatted skill bytes appended to one named-agent prompt. */
export const MAX_PRELOADED_SKILLS_TOTAL_BYTES = 256 * 1024;

export interface AgentSkillPreloadInput {
  names: readonly string[];
  cwd: string;
  projectTrusted: boolean;
  agentDir?: string;
  signal?: AbortSignal;
}

export interface AgentSkillPreloadResult {
  /** XML skill blocks ready to append to the named-agent system prompt. */
  content: string;
  loaded: string[];
  /** Missing, disabled, unreadable, or oversized skills are skipped. */
  warnings: string[];
}

type PreloadableSkill = Pick<
  Skill,
  "name" | "filePath" | "baseDir" | "disableModelInvocation"
>;

export interface AgentSkillPreloaderOptions {
  loadSkills?: (input: AgentSkillPreloadInput) => Promise<readonly PreloadableSkill[]>;
  readFile?: (filePath: string, maxBytes: number) => Promise<string>;
}

/**
 * Resolve and preload named skills with Claude-compatible semantics.
 * Unavailable skills never prevent the agent from launching; each is skipped
 * with a warning. Skill bodies use Pi's native `<skill>` envelope so relative
 * references retain their base directory in both Pi and Claude harnesses.
 */
export async function preloadAgentSkills(
  input: AgentSkillPreloadInput,
  options: AgentSkillPreloaderOptions = {},
): Promise<AgentSkillPreloadResult> {
  if (!Array.isArray(input.names) || input.names.length > MAX_AGENT_SKILLS) {
    return invalidDeclaration("Skill preload exceeds the name count limit.");
  }
  if (input.names.some((name) =>
    typeof name !== "string" ||
    name.length > MAX_AGENT_SKILL_NAME_CHARS ||
    !AGENT_SKILL_NAME_PATTERN.test(name)
  )) {
    return invalidDeclaration("Skill preload contains an invalid name.");
  }
  if (new Set(input.names).size !== input.names.length) {
    return invalidDeclaration("Skill preload contains a duplicate name.");
  }
  if (input.names.length === 0) return { content: "", loaded: [], warnings: [] };

  const loadSkills = options.loadSkills ?? loadOfficialSkills;
  const readSkillFile = options.readFile ?? readBoundedUtf8File;
  let available: readonly PreloadableSkill[];
  try {
    available = await loadSkills(input);
  } catch (error) {
    const warning = error instanceof SkillCatalogLimitError
      ? "Skill discovery reached a safety limit; no skills were preloaded."
      : "Skills could not be discovered; no skills were preloaded.";
    return { content: "", loaded: [], warnings: [warning] };
  }
  const skillsByName = new Map<string, PreloadableSkill>();
  for (const skill of available) {
    // Retain Pi's first-wins skill collision behavior in injected/test catalogs too.
    if (!skillsByName.has(skill.name)) skillsByName.set(skill.name, skill);
  }
  const blocks: string[] = [];
  const loaded: string[] = [];
  const warnings: string[] = [];
  let totalBytes = 0;

  for (const name of input.names) {
    const skill = skillsByName.get(name);
    if (!skill) {
      warnings.push(`Skill ${JSON.stringify(name)} was not found and was not preloaded.`);
      continue;
    }
    if (skill.disableModelInvocation) {
      warnings.push(
        `Skill ${JSON.stringify(name)} disables model invocation and was not preloaded.`,
      );
      continue;
    }

    let source: string;
    try {
      source = await readSkillFile(
        skill.filePath,
        MAX_PRELOADED_SKILL_FILE_BYTES,
      );
    } catch (error) {
      const reason = error instanceof SkillFileTooLargeError
        ? "exceeds the preload size limit"
        : "could not be read";
      warnings.push(`Skill ${JSON.stringify(name)} ${reason} and was not preloaded.`);
      continue;
    }
    if (Buffer.byteLength(source) > MAX_PRELOADED_SKILL_FILE_BYTES) {
      warnings.push(`Skill ${JSON.stringify(name)} exceeds the preload size limit and was skipped.`);
      continue;
    }

    const block = formatPreloadedSkill(skill, stripFrontmatter(source).trim());
    const blockBytes = Buffer.byteLength(block);
    const separatorBytes = blocks.length > 0 ? 2 : 0;
    if (totalBytes + separatorBytes + blockBytes > MAX_PRELOADED_SKILLS_TOTAL_BYTES) {
      warnings.push(
        `Skill ${JSON.stringify(name)} exceeds the aggregate preload size limit and was skipped.`,
      );
      continue;
    }
    totalBytes += separatorBytes + blockBytes;
    blocks.push(block);
    loaded.push(name);
  }

  return { content: blocks.join("\n\n"), loaded, warnings };
}

function invalidDeclaration(warning: string): AgentSkillPreloadResult {
  return { content: "", loaded: [], warnings: [warning] };
}

export function appendPreloadedSkills(
  systemPrompt: string | undefined,
  skillsContent: string,
): string | undefined {
  const prompt = systemPrompt?.trim() ?? "";
  const skills = skillsContent.trim();
  if (!prompt && !skills) return undefined;
  return [prompt, skills].filter(Boolean).join("\n\n");
}

export function formatPreloadedSkill(skill: PreloadableSkill, body: string): string {
  const name = escapeXmlAttribute(skill.name);
  const location = escapeXmlAttribute(skill.filePath);
  return [
    `<skill name="${name}" location="${location}">`,
    `References are relative to ${escapeXmlText(skill.baseDir)}.`,
    "",
    body,
    "</skill>",
  ].join("\n");
}

const MAX_SKILL_CATALOG_PATHS = 128;
const MAX_SKILL_CATALOG_DIRECTORIES = 128;
const MAX_SKILL_CATALOG_FILES = 256;
const MAX_SKILL_CATALOG_ENTRIES_PER_DIRECTORY = 512;
const MAX_SKILL_CATALOG_TOTAL_BYTES = 1024 * 1024;
const MAX_SKILL_CATALOG_METADATA_BYTES = 16 * 1024;
const MAX_SKILL_CATALOG_DEPTH = 5;

interface SkillCatalogBudget {
  directories: number;
  files: number;
  bytes: number;
  limited: boolean;
}

class SkillCatalogLimitError extends Error {}

async function loadOfficialSkills(
  input: AgentSkillPreloadInput,
): Promise<readonly PreloadableSkill[]> {
  throwIfAborted(input.signal);
  const agentDir = input.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(input.cwd, agentDir, {
    projectTrusted: input.projectTrusted,
  });
  await settingsManager.reload();
  throwIfAborted(input.signal);

  const packageManager = new DefaultPackageManager({
    cwd: input.cwd,
    agentDir,
    settingsManager,
  });
  const resolved = await packageManager.resolve(async () => "skip");
  throwIfAborted(input.signal);

  const allPaths = [...new Set(
    resolved.skills
      .filter((resource) => resource.enabled)
      .map((resource) => resource.path),
  )];
  return discoverBoundedSkills(
    allPaths.slice(0, MAX_SKILL_CATALOG_PATHS),
    new Set(input.names),
    allPaths.length > MAX_SKILL_CATALOG_PATHS,
    input.signal,
  );
}

async function discoverBoundedSkills(
  paths: readonly string[],
  requested: ReadonlySet<string>,
  pathLimitReached: boolean,
  signal: AbortSignal | undefined,
): Promise<PreloadableSkill[]> {
  const budget: SkillCatalogBudget = {
    directories: 0,
    files: 0,
    bytes: 0,
    limited: false,
  };
  const discovered = new Map<string, PreloadableSkill>();
  const visited = new Set<string>();
  for (const resourcePath of paths) {
    throwIfAborted(signal);
    await scanSkillPath(
      resourcePath,
      0,
      true,
      budget,
      discovered,
      visited,
      signal,
    );
    if (!budget.limited && [...requested].every((name) => discovered.has(name))) {
      return [...discovered.values()];
    }
    if (
      budget.directories >= MAX_SKILL_CATALOG_DIRECTORIES ||
      budget.files >= MAX_SKILL_CATALOG_FILES ||
      budget.bytes >= MAX_SKILL_CATALOG_TOTAL_BYTES
    ) break;
  }
  if (
    budget.limited ||
    (pathLimitReached && [...requested].some((name) => !discovered.has(name)))
  ) {
    throw new SkillCatalogLimitError();
  }
  return [...discovered.values()];
}

async function scanSkillPath(
  candidate: string,
  depth: number,
  root: boolean,
  budget: SkillCatalogBudget,
  discovered: Map<string, PreloadableSkill>,
  visited: Set<string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  try {
    candidate = await realpath(candidate);
  } catch {
    return;
  }
  if (visited.has(candidate)) return;
  visited.add(candidate);

  let stats;
  try {
    stats = await stat(candidate);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (basename(candidate) === "SKILL.md" || (root && candidate.toLowerCase().endsWith(".md"))) {
      await readCatalogSkill(candidate, budget, discovered, signal);
    }
    return;
  }
  if (!stats.isDirectory()) return;
  if (depth > MAX_SKILL_CATALOG_DEPTH) {
    budget.limited = true;
    return;
  }
  if (budget.directories >= MAX_SKILL_CATALOG_DIRECTORIES) {
    budget.limited = true;
    return;
  }
  budget.directories += 1;

  const skillFile = join(candidate, "SKILL.md");
  try {
    const skillStats = await lstat(skillFile);
    if (skillStats.isFile() || skillStats.isSymbolicLink()) {
      await scanSkillPath(
        skillFile,
        depth + 1,
        false,
        budget,
        discovered,
        visited,
        signal,
      );
      return;
    }
  } catch {
    // This directory is a container; inspect its bounded children below.
  }

  const entries: string[] = [];
  try {
    const directory = await opendir(candidate);
    for await (const entry of directory) {
      entries.push(entry.name);
      if (entries.length >= MAX_SKILL_CATALOG_ENTRIES_PER_DIRECTORY) {
        budget.limited = true;
        break;
      }
    }
    entries.sort((left, right) => left.localeCompare(right));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "SKILL.md") continue;
    if (budget.files >= MAX_SKILL_CATALOG_FILES) {
      budget.limited = true;
      return;
    }
    await scanSkillPath(
      join(candidate, entry),
      depth + 1,
      root && depth === 0,
      budget,
      discovered,
      visited,
      signal,
    );
  }
}

async function readCatalogSkill(
  filePath: string,
  budget: SkillCatalogBudget,
  discovered: Map<string, PreloadableSkill>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (
    budget.files >= MAX_SKILL_CATALOG_FILES ||
    budget.bytes >= MAX_SKILL_CATALOG_TOTAL_BYTES
  ) {
    budget.limited = true;
    return;
  }
  budget.files += 1;
  throwIfAborted(signal);

  let source: string;
  try {
    source = await readBoundedUtf8Prefix(
      filePath,
      MAX_SKILL_CATALOG_METADATA_BYTES,
    );
  } catch {
    return;
  }
  const bytes = Buffer.byteLength(source);
  if (budget.bytes + bytes > MAX_SKILL_CATALOG_TOTAL_BYTES) {
    budget.bytes = MAX_SKILL_CATALOG_TOTAL_BYTES;
    budget.limited = true;
    return;
  }
  budget.bytes += bytes;

  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter<Record<string, unknown>>(source).frontmatter;
  } catch {
    return;
  }
  const description = frontmatter.description;
  if (typeof description !== "string" || description.trim() === "") {
    if (bytes >= MAX_SKILL_CATALOG_METADATA_BYTES) budget.limited = true;
    return;
  }
  const declaredName = frontmatter.name;
  const name = typeof declaredName === "string" && declaredName.trim() !== ""
    ? declaredName.trim()
    : basename(dirname(filePath));
  if (discovered.has(name)) return;
  discovered.set(name, {
    name,
    filePath,
    baseDir: dirname(filePath),
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

class SkillFileTooLargeError extends Error {}

async function readBoundedUtf8Prefix(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("skill path is not a regular file");
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readBoundedUtf8File(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("skill path is not a regular file");
    if (stats.size > maxBytes) throw new SkillFileTooLargeError();

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw new SkillFileTooLargeError();
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
