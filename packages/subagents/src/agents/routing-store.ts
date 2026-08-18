import * as path from "node:path";
import { truncateText } from "../shared/truncate.js";
import { isAlreadyExists, isNotFound, nodeFileSystem, type AgentFileSystem } from "./fs-seam.js";
import {
  AGENT_NAME_PATTERN,
  MAX_AGENT_NAME_CHARS,
  MAX_BACKUP_ATTEMPTS,
  MAX_ROUTING_FILE_BYTES,
  MAX_ROUTING_MODEL_CHARS,
  MAX_WARNING_CHARS,
} from "./limits.js";
import type {
  RoutingEntry,
  RoutingFile,
  RoutingReadResult,
  RoutingScope,
  RoutingStore,
} from "./types.js";

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
const ROUTING_KEYS = new Set(["harness", "model", "thinking"]);

export interface FileRoutingStoreOptions {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  fs?: AgentFileSystem;
  now?: () => number;
}

/** Atomic, permission-restricted persistence for user and project routes. */
export class FileRoutingStore implements RoutingStore {
  private readonly fs: AgentFileSystem;
  private readonly agentDir: string;
  private readonly cwd: string;
  private readonly now: () => number;
  private tempSerial = 0;

  constructor(private readonly options: FileRoutingStoreOptions) {
    this.fs = options.fs ?? nodeFileSystem;
    this.agentDir = path.resolve(options.agentDir);
    this.cwd = path.resolve(options.cwd);
    this.now = options.now ?? Date.now;
  }

  routingPath(scope: RoutingScope): string {
    return scope === "user"
      ? path.join(this.agentDir, "subagents.json")
      : path.join(this.cwd, ".pi", "subagents.json");
  }

  async read(scope: RoutingScope): Promise<RoutingReadResult> {
    if (scope === "project" && !this.options.projectTrusted) return { routing: undefined };
    const filePath = this.routingPath(scope);
    const directoryCheck = await this.inspectContainingDirectory(path.dirname(filePath));
    if (directoryCheck === "missing") return { routing: undefined };
    if (directoryCheck) return { routing: undefined, invalidReason: bounded(directoryCheck) };

    let stats;
    try {
      stats = await this.fs.lstat(filePath);
    } catch (error) {
      if (isNotFound(error)) return { routing: undefined };
      return { routing: undefined, invalidReason: bounded(`Cannot inspect routing file: ${errorCode(error)}`) };
    }
    if (stats.isSymbolicLink) {
      return { routing: undefined, invalidReason: "Routing file must not be a symlink" };
    }
    if (!stats.isFile) {
      return { routing: undefined, invalidReason: "Routing path is not a regular file" };
    }
    if (stats.size > MAX_ROUTING_FILE_BYTES) {
      return { routing: undefined, invalidReason: "Routing file exceeds the size limit" };
    }

    let text: string;
    try {
      text = await this.fs.readFile(filePath);
    } catch (error) {
      return { routing: undefined, invalidReason: bounded(`Cannot read routing file: ${errorCode(error)}`) };
    }
    if (Buffer.byteLength(text) > MAX_ROUTING_FILE_BYTES) {
      return { routing: undefined, invalidReason: "Routing file exceeds the size limit" };
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return { routing: undefined, invalidReason: "Routing file contains invalid JSON" };
    }
    const parsed = parseRouting(raw);
    return parsed.ok
      ? { routing: parsed.routing }
      : { routing: undefined, invalidReason: bounded(parsed.reason) };
  }

  async write(scope: RoutingScope, routing: RoutingFile): Promise<void> {
    this.assertScopeWritable(scope);
    const parsedInput = parseRouting(routing);
    if (!parsedInput.ok) throw new Error(`Invalid routing data: ${bounded(parsedInput.reason)}`);

    const existing = await this.read(scope);
    if (existing.invalidReason) {
      throw new Error(`Refusing to overwrite invalid routing file; back it up first: ${existing.invalidReason}`);
    }
    const merged = preserveUnknownFields(existing.routing, parsedInput.routing);
    const data = `${JSON.stringify(merged, null, 2)}\n`;
    if (Buffer.byteLength(data) > MAX_ROUTING_FILE_BYTES) {
      throw new Error("Routing file exceeds the size limit");
    }

    const filePath = this.routingPath(scope);
    const directory = path.dirname(filePath);
    await this.ensurePrivateDirectory(directory);
    const tempPath = await this.findUnusedPath(
      directory,
      `.subagents.json.tmp-${process.pid}-${this.now()}-${this.tempSerial++}`,
    );
    let tempExists = false;
    try {
      await this.fs.writeFile(tempPath, data, 0o600);
      tempExists = true;
      await this.fs.chmod(tempPath, 0o600);
      await this.fs.rename(tempPath, filePath);
      tempExists = false;
      await this.fs.chmod(filePath, 0o600);
      await this.fs.chmod(directory, 0o700);
    } finally {
      if (tempExists) {
        try {
          await this.fs.unlink(tempPath);
        } catch {
          // The original write error is more useful than cleanup failure.
        }
      }
    }
  }

  async backupInvalid(scope: RoutingScope): Promise<string> {
    this.assertScopeWritable(scope);
    const result = await this.read(scope);
    if (!result.invalidReason) {
      throw new Error("Routing file is not invalid and does not need a backup");
    }

    const filePath = this.routingPath(scope);
    const directoryIssue = await this.inspectContainingDirectory(path.dirname(filePath));
    if (directoryIssue) {
      throw new Error("Cannot back up routing through a missing or unsafe directory");
    }
    const stats = await this.fs.lstat(filePath);
    if (stats.isDirectory || (!stats.isFile && !stats.isSymbolicLink)) {
      throw new Error("Invalid routing path is not a file and cannot be backed up");
    }
    const backupPath = await this.findUnusedPath(
      path.dirname(filePath),
      `subagents.json.invalid-${this.now()}`,
    );
    await this.fs.rename(filePath, backupPath);
    if (stats.isFile && !stats.isSymbolicLink) await this.fs.chmod(backupPath, 0o600);
    return backupPath;
  }

  private assertScopeWritable(scope: RoutingScope): void {
    if (scope === "project" && !this.options.projectTrusted) {
      throw new Error("Project routing is disabled because the project is not trusted");
    }
  }

  private async inspectContainingDirectory(directory: string): Promise<string | "missing" | undefined> {
    let stats;
    try {
      stats = await this.fs.lstat(directory);
    } catch (error) {
      if (isNotFound(error)) return "missing";
      return `Cannot inspect routing directory: ${errorCode(error)}`;
    }
    if (stats.isSymbolicLink) return "Routing directory must not be a symlink";
    if (!stats.isDirectory) return "Routing parent path is not a directory";
    try {
      if ((await this.fs.realpath(directory)) !== path.resolve(directory)) {
        return "Routing directory path must not cross a symlink";
      }
    } catch (error) {
      return `Cannot resolve routing directory: ${errorCode(error)}`;
    }
    return undefined;
  }

  private async ensurePrivateDirectory(directory: string): Promise<void> {
    const missing: string[] = [];
    let cursor = directory;
    while (true) {
      try {
        const stats = await this.fs.lstat(cursor);
        if (stats.isSymbolicLink) throw new Error(`Refusing symlinked routing directory: ${cursor}`);
        if (!stats.isDirectory) throw new Error(`Routing parent path is not a directory: ${cursor}`);
        break;
      } catch (error) {
        if (!isNotFound(error)) throw error;
        missing.push(cursor);
        const parent = path.dirname(cursor);
        if (parent === cursor) throw new Error(`Cannot create routing directory: ${directory}`);
        cursor = parent;
      }
    }

    for (const candidate of missing.reverse()) {
      try {
        await this.fs.mkdir(candidate, 0o700);
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        const stats = await this.fs.lstat(candidate);
        if (stats.isSymbolicLink || !stats.isDirectory) {
          throw new Error(`Refusing unsafe routing directory: ${candidate}`);
        }
      }
    }
    if ((await this.fs.realpath(directory)) !== path.resolve(directory)) {
      throw new Error(`Refusing routing directory that crosses a symlink: ${directory}`);
    }
    await this.fs.chmod(directory, 0o700);
  }

  private async findUnusedPath(directory: string, basename: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_BACKUP_ATTEMPTS; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const candidate = path.join(directory, `${basename}${suffix}`);
      try {
        await this.fs.lstat(candidate);
      } catch (error) {
        if (isNotFound(error)) return candidate;
        throw error;
      }
    }
    throw new Error("Could not allocate a safe routing backup or temporary filename");
  }
}

type RoutingParseResult =
  | { ok: true; routing: RoutingFile }
  | { ok: false; reason: string };

function parseRouting(value: unknown): RoutingParseResult {
  if (!isRecord(value)) return { ok: false, reason: "Routing file must contain an object" };
  if (value.version !== 1) return { ok: false, reason: "Routing file version must be 1" };
  if (!isRecord(value.agents)) return { ok: false, reason: "Routing file agents must be an object" };

  const agents: Record<string, RoutingEntry> = {};
  for (const [name, rawEntry] of Object.entries(value.agents)) {
    if (
      !name ||
      name.length > MAX_AGENT_NAME_CHARS ||
      !AGENT_NAME_PATTERN.test(name)
    ) {
      return { ok: false, reason: `Routing agent name is invalid: ${bounded(name)}` };
    }
    if (!isRecord(rawEntry)) return { ok: false, reason: `Routing entry for ${name} must be an object` };
    if (rawEntry.harness !== undefined && !HARNESSES.has(rawEntry.harness as string)) {
      return { ok: false, reason: `Routing entry for ${name} has an invalid harness` };
    }
    if (rawEntry.model !== undefined) {
      if (
        typeof rawEntry.model !== "string" ||
        !rawEntry.model.trim() ||
        rawEntry.model.length > MAX_ROUTING_MODEL_CHARS
      ) {
        return { ok: false, reason: `Routing entry for ${name} has an invalid model` };
      }
    }
    if (rawEntry.thinking !== undefined && !THINKING_LEVELS.has(rawEntry.thinking as string)) {
      return { ok: false, reason: `Routing entry for ${name} has an invalid thinking level` };
    }
    agents[name] = { ...rawEntry } as RoutingEntry;
  }

  return {
    ok: true,
    routing: { ...value, version: 1, agents } as RoutingFile,
  };
}

function preserveUnknownFields(
  existing: RoutingFile | undefined,
  next: RoutingFile,
): RoutingFile {
  if (!existing) return next;
  const rootUnknown = unknownFields(existing, new Set(["version", "agents"]));
  const agents: Record<string, RoutingEntry> = {};
  for (const [name, entry] of Object.entries(next.agents)) {
    const oldEntry = existing.agents[name];
    agents[name] = oldEntry
      ? { ...unknownFields(oldEntry, ROUTING_KEYS), ...entry }
      : entry;
  }
  return { ...rootUnknown, ...next, version: 1, agents };
}

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !known.has(key)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bounded(value: string): string {
  return truncateText(value, MAX_WARNING_CHARS);
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === "string" && /^[A-Z0-9_]+$/.test(code)) return code;
  }
  return "filesystem error";
}
