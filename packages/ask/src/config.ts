import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CONFIG_SCHEMA_VERSION = 5;
export const CONFIG_BASENAME = "yteruel31-pi-ask.json";

export type NotificationChannel = "bell" | "osc9" | "osc777" | { type: "command"; command: string };
export type KeymapContext = "global" | "main" | "editor" | "noteEditor" | "settingsModal";

export interface AskConfig {
  schemaVersion: 5;
  answer: {
    extractionModels: Array<{ provider: string; id: string }>;
    extractionTimeoutMs: number;
    extractionRetries: number;
  };
  behaviour: {
    autoSubmitWhenAnsweredWithoutNotes: boolean;
    confirmDismissWhenDirty: boolean;
    doublePressReviewShortcuts: boolean;
    presentSingleAsMulti: boolean;
    showFooterHints: boolean;
  };
  keymaps: {
    global: { dismiss: string[]; settings: string[] };
    main: {
      confirm: string[]; cancel: string[]; toggle: string[]; changeQuestionType: string[];
      nextTab: string[]; previousTab: string[]; nextOption: string[]; previousOption: string[];
      optionNote: string[]; questionNote: string[];
    };
    editor: {
      submit: string[]; close: string[]; nextTabWhenEmpty: string[]; previousTabWhenEmpty: string[];
      nextOptionWhenEmpty: string[]; previousOptionWhenEmpty: string[];
    };
    noteEditor: {
      save: string[]; close: string[]; nextTabWhenEmpty: string[]; previousTabWhenEmpty: string[];
      nextOptionWhenEmpty: string[]; previousOptionWhenEmpty: string[];
    };
    settingsModal: { close: string[]; nextOption: string[]; previousOption: string[]; toggle: string[] };
  };
  notifications: { enabled: boolean; channels: NotificationChannel[] };
}

const KEYMAP_ACTIONS = {
  global: ["dismiss", "settings"],
  main: ["confirm", "cancel", "toggle", "changeQuestionType", "nextTab", "previousTab", "nextOption", "previousOption", "optionNote", "questionNote"],
  editor: ["submit", "close", "nextTabWhenEmpty", "previousTabWhenEmpty", "nextOptionWhenEmpty", "previousOptionWhenEmpty"],
  noteEditor: ["save", "close", "nextTabWhenEmpty", "previousTabWhenEmpty", "nextOptionWhenEmpty", "previousOptionWhenEmpty"],
  settingsModal: ["close", "nextOption", "previousOption", "toggle"],
} as const;

export const DEFAULT_CONFIG: AskConfig = {
  schemaVersion: 5,
  answer: {
    extractionModels: [
      { provider: "openai-codex", id: "gpt-5.4-mini" },
      { provider: "github-copilot", id: "gpt-5.4-mini" },
      { provider: "anthropic", id: "claude-haiku-4-5" },
    ],
    extractionTimeoutMs: 30_000,
    extractionRetries: 1,
  },
  behaviour: {
    autoSubmitWhenAnsweredWithoutNotes: false,
    confirmDismissWhenDirty: true,
    doublePressReviewShortcuts: true,
    presentSingleAsMulti: false,
    showFooterHints: true,
  },
  keymaps: {
    global: { dismiss: ["ctrl+c"], settings: ["?"] },
    main: {
      confirm: ["enter"], cancel: ["esc"], toggle: ["space"], changeQuestionType: ["t"],
      nextTab: ["tab", "right"], previousTab: ["shift+tab", "left"], nextOption: ["down"], previousOption: ["up"],
      optionNote: ["n"], questionNote: ["shift+n"],
    },
    editor: {
      submit: ["enter"], close: ["esc"], nextTabWhenEmpty: ["tab", "right"], previousTabWhenEmpty: ["shift+tab", "left"],
      nextOptionWhenEmpty: ["down"], previousOptionWhenEmpty: ["up"],
    },
    noteEditor: {
      save: ["enter"], close: ["esc"], nextTabWhenEmpty: ["tab", "right"], previousTabWhenEmpty: ["shift+tab", "left"],
      nextOptionWhenEmpty: ["down"], previousOptionWhenEmpty: ["up"],
    },
    settingsModal: { close: ["esc", "ctrl+c", "?"], nextOption: ["down"], previousOption: ["up"], toggle: ["enter", "space"] },
  },
  notifications: { enabled: true, channels: ["bell"] },
};

export function cloneConfig(config: AskConfig = DEFAULT_CONFIG): AskConfig {
  return structuredClone(config);
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeKey(key: string): string {
  const parts = key.trim().replaceAll(/\s+/g, "").toLowerCase().split("+");
  const normalized = parts.map((part, index) => {
    if (part === "control") return "ctrl";
    if (index !== parts.length - 1) return part;
    if (part === "escape") return "esc";
    if (part === "return") return "enter";
    if (part === "pageup") return "pageUp";
    if (part === "pagedown") return "pageDown";
    return part;
  });
  return normalized.join("+");
}

const BASE_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "esc", "enter", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end", "pageUp", "pageDown",
  "up", "down", "left", "right", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  ..."`-=[]\\;',./!@#$%^&*()_+|~{}:<>?".split(""),
]);

export function isKeyId(key: string): boolean {
  let remaining = normalizeKey(key);
  const modifiers = new Set<string>();
  while (true) {
    const match = remaining.match(/^(ctrl|shift|alt|super)\+/);
    if (!match) break;
    const modifier = match[1]!;
    if (modifiers.has(modifier)) return false;
    modifiers.add(modifier);
    remaining = remaining.slice(match[0].length);
  }
  return BASE_KEYS.has(remaining);
}

function normalizeBindings(value: unknown): string[] | undefined {
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : undefined;
  if (!values?.length || values.some((item) => typeof item !== "string" || !isKeyId(item))) return undefined;
  return values.map((item) => normalizeKey(item as string));
}

export function validateKeymaps(raw: unknown): { keymaps: AskConfig["keymaps"]; valid: boolean; warning?: string } {
  const root = object(raw);
  if (!root) return { keymaps: cloneConfig().keymaps, valid: false, warning: "keymaps must be an object" };
  const result = {} as Record<string, Record<string, string[]>>;
  for (const [context, actions] of Object.entries(KEYMAP_ACTIONS) as Array<[KeymapContext, readonly string[]]>) {
    const source = object(root[context]);
    if (!source) return { keymaps: cloneConfig().keymaps, valid: false, warning: `missing keymap context ${context}` };
    const used = new Set<string>();
    result[context] = {};
    for (const action of actions) {
      const bindings = normalizeBindings(source[action]);
      if (!bindings) return { keymaps: cloneConfig().keymaps, valid: false, warning: `invalid binding for ${context}.${action}` };
      for (const binding of bindings) {
        if (/^[1-9]$/.test(binding)) return { keymaps: cloneConfig().keymaps, valid: false, warning: `numeric shortcut ${binding} is fixed` };
        if (used.has(binding)) return { keymaps: cloneConfig().keymaps, valid: false, warning: `duplicate binding ${binding} in ${context}` };
        used.add(binding);
      }
      result[context]![action] = bindings;
    }
  }
  const globals = new Set(Object.values(result.global!).flat());
  for (const context of ["main", "editor", "noteEditor"] as const) {
    for (const binding of Object.values(result[context]!).flat()) {
      if (globals.has(binding)) return { keymaps: cloneConfig().keymaps, valid: false, warning: `global binding ${binding} conflicts with ${context}` };
    }
  }
  return { keymaps: result as unknown as AskConfig["keymaps"], valid: true };
}

function channels(value: unknown): NotificationChannel[] {
  if (!Array.isArray(value)) return cloneConfig().notifications.channels;
  const valid: NotificationChannel[] = [];
  for (const item of value) {
    if (item === "bell" || item === "osc9" || item === "osc777") valid.push(item);
    else {
      const entry = object(item);
      if (entry?.type === "command" && typeof entry.command === "string" && entry.command.trim()) {
        valid.push({ type: "command", command: entry.command });
      }
    }
  }
  return valid.length ? valid : ["bell"];
}

export interface ConfigParseResult {
  config: AskConfig;
  migrated: boolean;
  warning?: string;
  invalid?: string;
}

/** Supported older versions are migrated only in memory and never rewritten during load. */
export function parseConfig(raw: unknown): ConfigParseResult {
  const root = object(raw);
  if (!root) return { config: cloneConfig(), migrated: false, invalid: "configuration must be a JSON object" };
  const version = root.schemaVersion === undefined ? 1 : root.schemaVersion;
  if (!Number.isInteger(version) || (version as number) < 1 || (version as number) > CONFIG_SCHEMA_VERSION) {
    return { config: cloneConfig(), migrated: false, invalid: `unsupported schemaVersion ${String(version)}` };
  }
  const defaults = cloneConfig();
  const answer = object(root.answer);
  const behaviour = object(root.behaviour) ?? object(root.behavior);
  const notifications = object(root.notifications);
  if (version === 5 && (!answer || !behaviour || !object(root.keymaps) || !notifications)) {
    return { config: defaults, migrated: false, invalid: "schema version 5 requires answer, behaviour, keymaps, and notifications objects" };
  }
  if (answer) {
    if ((version === 5 || answer.extractionModels !== undefined) && (!Array.isArray(answer.extractionModels)
      || answer.extractionModels.some((item) => {
        const entry = object(item);
        return typeof entry?.provider !== "string" || !entry.provider.trim() || typeof entry.id !== "string" || !entry.id.trim();
      }))) return { config: defaults, migrated: version !== 5, invalid: "answer.extractionModels must contain provider/id string pairs" };
    if ((version === 5 || answer.extractionTimeoutMs !== undefined)
      && (typeof answer.extractionTimeoutMs !== "number" || !Number.isFinite(answer.extractionTimeoutMs) || answer.extractionTimeoutMs <= 0)) {
      return { config: defaults, migrated: version !== 5, invalid: "answer.extractionTimeoutMs must be positive" };
    }
    if ((version === 5 || answer.extractionRetries !== undefined)
      && (typeof answer.extractionRetries !== "number" || !Number.isInteger(answer.extractionRetries) || answer.extractionRetries < 0 || answer.extractionRetries > 3)) {
      return { config: defaults, migrated: version !== 5, invalid: "answer.extractionRetries must be an integer from 0 to 3" };
    }
  }
  if (behaviour) {
    for (const key of Object.keys(defaults.behaviour) as Array<keyof AskConfig["behaviour"]>) {
      if (behaviour[key] !== undefined && typeof behaviour[key] !== "boolean") {
        return { config: defaults, migrated: version !== 5, invalid: `behaviour.${key} must be boolean` };
      }
    }
  }
  if (notifications && notifications.enabled !== undefined && typeof notifications.enabled !== "boolean") {
    return { config: defaults, migrated: version !== 5, invalid: "notifications.enabled must be boolean" };
  }
  if (notifications?.channels !== undefined && !Array.isArray(notifications.channels)) {
    return { config: defaults, migrated: version !== 5, invalid: "notifications.channels must be an array" };
  }
  const models = Array.isArray(answer?.extractionModels)
    ? answer.extractionModels.flatMap((item) => {
      const entry = object(item);
      return typeof entry?.provider === "string" && entry.provider.trim() && typeof entry.id === "string" && entry.id.trim()
        ? [{ provider: entry.provider.trim(), id: entry.id.trim() }]
        : [];
    })
    : defaults.answer.extractionModels;
  const timeout = answer?.extractionTimeoutMs;
  const retries = answer?.extractionRetries;
  const keymaps = validateKeymaps(root.keymaps ?? defaults.keymaps);
  const config: AskConfig = {
    schemaVersion: 5,
    answer: {
      extractionModels: models,
      extractionTimeoutMs: typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : defaults.answer.extractionTimeoutMs,
      extractionRetries: typeof retries === "number" && Number.isInteger(retries) && retries >= 0 && retries <= 3 ? retries : defaults.answer.extractionRetries,
    },
    behaviour: {
      autoSubmitWhenAnsweredWithoutNotes: bool(behaviour?.autoSubmitWhenAnsweredWithoutNotes, defaults.behaviour.autoSubmitWhenAnsweredWithoutNotes),
      confirmDismissWhenDirty: bool(behaviour?.confirmDismissWhenDirty, defaults.behaviour.confirmDismissWhenDirty),
      doublePressReviewShortcuts: bool(behaviour?.doublePressReviewShortcuts, defaults.behaviour.doublePressReviewShortcuts),
      presentSingleAsMulti: bool(behaviour?.presentSingleAsMulti, defaults.behaviour.presentSingleAsMulti),
      showFooterHints: bool(behaviour?.showFooterHints, defaults.behaviour.showFooterHints),
    },
    keymaps: keymaps.keymaps,
    notifications: {
      enabled: bool(notifications?.enabled ?? root.notifications, defaults.notifications.enabled),
      channels: channels(notifications?.channels),
    },
  };
  return {
    config,
    migrated: version !== 5,
    ...(keymaps.warning ? { warning: `${keymaps.warning}; using default keymaps` } : {}),
  };
}

export function agentDirectory(): string {
  return getAgentDir();
}

export function configPath(agentDir = agentDirectory()): string {
  return join(agentDir, "extensions", CONFIG_BASENAME);
}

export function fallbackConfigPaths(agentDir = agentDirectory()): string[] {
  return [
    join(agentDir, CONFIG_BASENAME),
    join(agentDir, "extensions", "eko24ive-pi-ask.json"),
    join(agentDir, "eko24ive-pi-ask.json"),
  ];
}

export interface ConfigLoadNotice { kind: "warning" | "error"; message: string }
export interface FileAdapter {
  read(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
}

const diskAdapter: FileAdapter = {
  read: (path) => readFile(path, "utf8"),
  async write(path, text) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  },
};

export class ConfigStore {
  private value = cloneConfig();
  private listeners = new Set<(config: AskConfig) => void>();
  private loadedFrom?: string;
  private existsAtPrimary = false;
  private writeQueue: Promise<void> = Promise.resolve();
  readonly notices: ConfigLoadNotice[] = [];
  readonly path: string;
  private readonly fallbacks: string[];
  private readonly files: FileAdapter;

  constructor(
    path = configPath(),
    fallbacks = fallbackConfigPaths(dirname(dirname(path))),
    files: FileAdapter = diskAdapter,
  ) {
    this.path = path;
    this.fallbacks = fallbacks;
    this.files = files;
  }

  get(): AskConfig { return cloneConfig(this.value); }
  get sourcePath(): string | undefined { return this.loadedFrom; }

  subscribe(listener: (config: AskConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(config: AskConfig): void {
    this.value = cloneConfig(config);
    for (const listener of this.listeners) listener(this.get());
  }

  async load(): Promise<AskConfig> {
    this.notices.length = 0;
    let text: string | undefined;
    let source: string | undefined;
    for (const candidate of [this.path, ...this.fallbacks]) {
      try {
        text = await this.files.read(candidate);
        source = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          this.notices.push({ kind: "error", message: `Could not read ${candidate}; using defaults without changing the file.` });
          this.publish(cloneConfig());
          return this.get();
        }
      }
    }
    if (text === undefined) {
      this.loadedFrom = undefined;
      this.existsAtPrimary = false;
      this.publish(cloneConfig());
      return this.get();
    }
    this.loadedFrom = source;
    this.existsAtPrimary = source === this.path;
    let raw: unknown;
    try { raw = JSON.parse(text); }
    catch {
      this.notices.push({ kind: "error", message: `Invalid JSON in ${source}; using defaults without changing the file.` });
      this.publish(cloneConfig());
      return this.get();
    }
    const parsed = parseConfig(raw);
    if (parsed.invalid) {
      this.notices.push({ kind: "error", message: `${parsed.invalid} in ${source}; using defaults without changing the file.` });
      this.publish(cloneConfig());
      return this.get();
    }
    if (parsed.warning) this.notices.push({ kind: "warning", message: parsed.warning });
    this.publish(parsed.config);
    return this.get();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(task, task);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async persist(next: AskConfig): Promise<{ ok: true } | { ok: false; message: string }> {
    const parsed = parseConfig(next);
    if (parsed.invalid) return { ok: false, message: parsed.invalid };
    try {
      await this.files.write(this.path, `${JSON.stringify(parsed.config, null, 2)}\n`);
      this.existsAtPrimary = true;
      this.loadedFrom = this.path;
      this.publish(parsed.config);
      return { ok: true };
    } catch {
      return { ok: false, message: `Could not save ask settings. Edit ${this.path} manually.` };
    }
  }

  async ensureCreated(): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.existsAtPrimary || this.loadedFrom) return true;
      try {
        await this.files.write(this.path, `${JSON.stringify(this.value, null, 2)}\n`);
        this.existsAtPrimary = true;
        this.loadedFrom = this.path;
        return true;
      } catch {
        this.notices.push({ kind: "error", message: `Could not create ${this.path}; using in-memory defaults.` });
        return false;
      }
    });
  }

  async replace(next: AskConfig): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.enqueue(() => this.persist(next));
  }

  async update(mutator: (draft: AskConfig) => void): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.enqueue(() => {
      const next = this.get();
      mutator(next);
      return this.persist(next);
    });
  }

  async reset(): Promise<{ ok: true } | { ok: false; message: string }> {
    return this.enqueue(() => this.persist(cloneConfig()));
  }
}

export function bindingMatches(data: string, bindings: string[], matches: (data: string, key: string) => boolean): boolean {
  return bindings.some((binding) => matches(data, binding));
}
