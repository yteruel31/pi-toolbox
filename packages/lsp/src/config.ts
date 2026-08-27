import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import type { DiagnosticsConfig, LspConfig, ServerDefinition } from "./types.js";

const DEFAULT_DIAGNOSTICS: DiagnosticsConfig = {
  enabled: true,
  inlineTimeoutMs: 3_000,
  deferredTimeoutMs: 25_000,
  maxDiagnostics: 50,
};

const DEFAULT_SERVERS: ServerDefinition[] = [
  {
    name: "basedpyright",
    command: "basedpyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", ".git"],
    languageIds: { ".py": "python", ".pyi": "python" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "pyright",
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "pyrightconfig.json", "setup.py", "setup.cfg", "requirements.txt", ".git"],
    languageIds: { ".py": "python", ".pyi": "python" },
    features: { diagnostics: true, semantics: true },
    priority: 20,
  },
  {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".mjs": "javascript",
      ".cjs": "javascript",
    },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "biome",
    command: "biome",
    args: ["lsp-proxy"],
    fileTypes: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", ".json", ".jsonc", ".css"],
    rootMarkers: ["biome.json", "biome.jsonc"],
    languageIds: {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact",
      ".mts": "typescript",
      ".cts": "typescript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".json": "json",
      ".jsonc": "jsonc",
      ".css": "css",
    },
    features: { diagnostics: true, semantics: false },
    priority: 20,
  },
  {
    name: "rust-analyzer",
    command: "rust-analyzer",
    args: [],
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", "rust-project.json", ".git"],
    languageIds: { ".rs": "rust" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "gopls",
    command: "gopls",
    args: [],
    fileTypes: [".go"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    languageIds: { ".go": "go" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "clangd",
    command: "clangd",
    args: [],
    fileTypes: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".m", ".mm"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd", "CMakeLists.txt", ".git"],
    languageIds: {
      ".c": "c",
      ".h": "c",
      ".cc": "cpp",
      ".cpp": "cpp",
      ".cxx": "cpp",
      ".hpp": "cpp",
      ".hh": "cpp",
      ".hxx": "cpp",
      ".m": "objective-c",
      ".mm": "objective-cpp",
    },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "lua",
    command: "lua-language-server",
    args: [],
    fileTypes: [".lua"],
    rootMarkers: [".luarc.json", ".luarc.jsonc", ".git"],
    languageIds: { ".lua": "lua" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "svelte",
    command: "svelteserver",
    args: ["--stdio"],
    fileTypes: [".svelte"],
    rootMarkers: ["svelte.config.js", "svelte.config.ts", "package.json", ".git"],
    languageIds: { ".svelte": "svelte" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "vue",
    command: "vue-language-server",
    args: ["--stdio"],
    fileTypes: [".vue"],
    rootMarkers: ["vite.config.ts", "vite.config.js", "package.json", ".git"],
    languageIds: { ".vue": "vue" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
  {
    name: "bash",
    command: "bash-language-server",
    args: ["start"],
    fileTypes: [".sh", ".bash", ".zsh"],
    rootMarkers: [".git"],
    languageIds: { ".sh": "shellscript", ".bash": "shellscript", ".zsh": "shellscript" },
    features: { diagnostics: true, semantics: true },
    priority: 10,
  },
];

interface RawServerConfig {
  command?: unknown;
  args?: unknown;
  fileTypes?: unknown;
  rootMarkers?: unknown;
  languageIds?: unknown;
  languageId?: unknown;
  initializationOptions?: unknown;
  settings?: unknown;
  disabled?: unknown;
  priority?: unknown;
  features?: unknown;
}

interface RawConfig {
  servers?: unknown;
  diagnostics?: unknown;
  idleTimeoutMs?: unknown;
  requestTimeoutMs?: unknown;
  initFailureBackoffMs?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return undefined;
  return value;
}

function positiveInteger(value: unknown, fallback: number, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

async function readJson(filePath: string, warnings: string[]): Promise<RawConfig | null> {
  try {
    if ((await stat(filePath)).size > 1024 * 1024) {
      warnings.push(`${filePath}: configuration exceeds 1MB`);
      return null;
    }
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      warnings.push(`${filePath}: expected a JSON object`);
      return null;
    }
    return parsed as RawConfig;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    warnings.push(error instanceof SyntaxError ? `${filePath}: invalid JSON` : `${filePath}: could not read LSP configuration`);
    return null;
  }
}

function mergeServer(base: ServerDefinition | undefined, name: string, raw: RawServerConfig, warnings: string[]): ServerDefinition | null {
  const command = typeof raw.command === "string" ? raw.command : base?.command;
  const args = stringArray(raw.args) ?? base?.args ?? [];
  const fileTypes = stringArray(raw.fileTypes) ?? base?.fileTypes;
  const rootMarkers = stringArray(raw.rootMarkers) ?? base?.rootMarkers;
  const initializationOptions = isRecord(raw.initializationOptions) ? raw.initializationOptions : base?.initializationOptions;
  const settings = isRecord(raw.settings) ? raw.settings : base?.settings;
  const disabled = typeof raw.disabled === "boolean" ? raw.disabled : base?.disabled;
  const priority = typeof raw.priority === "number" && Number.isFinite(raw.priority) ? raw.priority : base?.priority ?? 100;
  const features = { ...(base?.features ?? { diagnostics: true, semantics: true }) };
  if (raw.features !== undefined) {
    if (!isRecord(raw.features)) {
      warnings.push(`server ${name}: features must be an object`);
    } else {
      if (typeof raw.features.diagnostics === "boolean") features.diagnostics = raw.features.diagnostics;
      else if (raw.features.diagnostics !== undefined) warnings.push(`server ${name}: features.diagnostics must be a boolean`);
      if (typeof raw.features.semantics === "boolean") features.semantics = raw.features.semantics;
      else if (raw.features.semantics !== undefined) warnings.push(`server ${name}: features.semantics must be a boolean`);
    }
  }

  let languageIds = base?.languageIds ?? {};
  if (isRecord(raw.languageIds)) {
    languageIds = Object.fromEntries(Object.entries(raw.languageIds).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } else if (typeof raw.languageId === "string" && fileTypes) {
    languageIds = Object.fromEntries(fileTypes.map((type) => [type, raw.languageId as string]));
  }

  if (!command || !fileTypes?.length || !rootMarkers?.length) {
    warnings.push(`server ${name}: command, fileTypes, and rootMarkers are required`);
    return null;
  }

  return {
    name,
    command,
    args,
    fileTypes,
    rootMarkers,
    languageIds,
    initializationOptions,
    settings,
    disabled,
    priority,
    features,
  };
}

function mergeRawConfig(
  state: { servers: Map<string, ServerDefinition>; diagnostics: DiagnosticsConfig; idleTimeoutMs: number; requestTimeoutMs: number; initFailureBackoffMs: number },
  raw: RawConfig,
  warnings: string[],
): void {
  if (isRecord(raw.servers)) {
    for (const [name, value] of Object.entries(raw.servers)) {
      if (value === false) {
        const existing = state.servers.get(name);
        if (existing) state.servers.set(name, { ...existing, disabled: true });
        continue;
      }
      if (!isRecord(value)) {
        warnings.push(`server ${name}: expected an object or false`);
        continue;
      }
      const merged = mergeServer(state.servers.get(name), name, value as RawServerConfig, warnings);
      if (merged) state.servers.set(name, merged);
    }
  }

  if (isRecord(raw.diagnostics)) {
    const diagnostics = raw.diagnostics;
    if (typeof diagnostics.enabled === "boolean") state.diagnostics.enabled = diagnostics.enabled;
    state.diagnostics.inlineTimeoutMs = positiveInteger(diagnostics.inlineTimeoutMs, state.diagnostics.inlineTimeoutMs, 50, 30_000);
    state.diagnostics.deferredTimeoutMs = positiveInteger(diagnostics.deferredTimeoutMs, state.diagnostics.deferredTimeoutMs, 100, 120_000);
    state.diagnostics.maxDiagnostics = positiveInteger(diagnostics.maxDiagnostics, state.diagnostics.maxDiagnostics, 1, 50);
  }
  state.idleTimeoutMs = positiveInteger(raw.idleTimeoutMs, state.idleTimeoutMs, 1_000, 3_600_000);
  state.requestTimeoutMs = positiveInteger(raw.requestTimeoutMs, state.requestTimeoutMs, 1_000, 300_000);
  state.initFailureBackoffMs = positiveInteger(raw.initFailureBackoffMs, state.initFailureBackoffMs, 1_000, 3_600_000);
}

export interface LoadConfigOptions {
  cwd: string;
  agentDir: string;
  configDirName: string;
  projectTrusted: boolean;
}

export async function loadConfig(options: LoadConfigOptions): Promise<LspConfig> {
  const warnings: string[] = [];
  const state = {
    servers: new Map(DEFAULT_SERVERS.map((server) => [server.name, { ...server, args: [...server.args], fileTypes: [...server.fileTypes], rootMarkers: [...server.rootMarkers], languageIds: { ...server.languageIds }, features: { ...server.features } }])),
    diagnostics: { ...DEFAULT_DIAGNOSTICS },
    idleTimeoutMs: 300_000,
    requestTimeoutMs: 20_000,
    initFailureBackoffMs: 180_000,
  };

  const userConfig = await readJson(path.join(options.agentDir, "lsp.json"), warnings);
  if (userConfig) mergeRawConfig(state, userConfig, warnings);

  if (options.projectTrusted) {
    const projectConfig = await readJson(path.join(options.cwd, options.configDirName, "lsp.json"), warnings);
    if (projectConfig) mergeRawConfig(state, projectConfig, warnings);
  }

  if (state.diagnostics.deferredTimeoutMs < state.diagnostics.inlineTimeoutMs) {
    warnings.push("diagnostics.deferredTimeoutMs was raised to match inlineTimeoutMs");
    state.diagnostics.deferredTimeoutMs = state.diagnostics.inlineTimeoutMs;
  }

  return {
    servers: [...state.servers.values()].filter((server) => !server.disabled).sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name)),
    diagnostics: state.diagnostics,
    idleTimeoutMs: state.idleTimeoutMs,
    requestTimeoutMs: state.requestTimeoutMs,
    initFailureBackoffMs: state.initFailureBackoffMs,
    warnings,
  };
}

export { DEFAULT_SERVERS };
