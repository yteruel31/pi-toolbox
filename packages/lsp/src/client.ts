import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { fileToUri, languageIdFor } from "./paths.js";
import { MessageFramer, writeMessage } from "./protocol.js";
import type {
  Diagnostic,
  JsonRpcId,
  JsonRpcMessage,
  PublishedDiagnostics,
  ResolvedServer,
  ServerDefinition,
} from "./types.js";

function cleanProcessText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
}

interface DiagnosticsWaiter {
  afterGeneration: number;
  expectedDocumentVersion: number;
  resolve: (value: PublishedDiagnostics) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  abort?: () => void;
}

interface OpenDocument {
  text: string;
  version: number;
  languageId: string;
}

interface SynchronizationOptions {
  openClose: boolean;
  change: 0 | 1 | 2;
  save: boolean;
  includeTextOnSave: boolean;
}

export class LspResponseError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "LspResponseError";
  }
}

export class LspTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspTimeoutError";
  }
}

function normalizedPosition(value: unknown): { line: number; character: number } | null {
  if (typeof value !== "object" || value === null) return null;
  const position = value as { line?: unknown; character?: unknown };
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character)) return null;
  const line = position.line as number;
  const character = position.character as number;
  if (line < 0 || character < 0) return null;
  return { line, character };
}

function normalizedDiagnostic(value: unknown): Diagnostic | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as {
    range?: { start?: unknown; end?: unknown };
    severity?: unknown;
    code?: unknown;
    source?: unknown;
    message?: unknown;
  };
  const start = normalizedPosition(candidate.range?.start);
  const end = normalizedPosition(candidate.range?.end);
  if (!start || !end || typeof candidate.message !== "string") return null;
  const severity = candidate.severity === 1 || candidate.severity === 2 || candidate.severity === 3 || candidate.severity === 4
    ? candidate.severity
    : undefined;
  const code = typeof candidate.code === "number"
    ? candidate.code
    : typeof candidate.code === "string"
      ? candidate.code.slice(0, 100)
      : undefined;
  const source = typeof candidate.source === "string" ? candidate.source.slice(0, 100) : undefined;
  return {
    range: { start, end },
    severity,
    code,
    source,
    message: candidate.message.slice(0, 500),
  };
}

function parseSynchronizationOptions(value: unknown): SynchronizationOptions {
  if (value === 0 || value === 1 || value === 2) {
    return { openClose: true, change: value, save: true, includeTextOnSave: false };
  }
  if (typeof value !== "object" || value === null) {
    return { openClose: false, change: 0, save: false, includeTextOnSave: false };
  }
  const options = value as { openClose?: unknown; change?: unknown; save?: unknown };
  const change = options.change === 1 || options.change === 2 ? options.change : 0;
  const save = options.save;
  return {
    openClose: options.openClose === true,
    change,
    save: save === true || (typeof save === "object" && save !== null),
    includeTextOnSave: typeof save === "object" && save !== null && "includeText" in save && save.includeText === true,
  };
}

const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true, dynamicRegistration: false, willSave: false, willSaveWaitUntil: false },
    hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
    rename: { dynamicRegistration: false, prepareSupport: true },
    publishDiagnostics: {
      relatedInformation: true,
      versionSupport: true,
      tagSupport: { valueSet: [1, 2] },
      codeDescriptionSupport: true,
      dataSupport: true,
    },
  },
  workspace: {
    applyEdit: false,
    configuration: true,
    workspaceFolders: true,
    workspaceEdit: {
      documentChanges: true,
      resourceOperations: [],
      failureHandling: "abort",
    },
  },
  window: { workDoneProgress: true },
};

export interface SyncResult {
  uri: string;
  changed: boolean;
  documentVersion: number;
  beforeDiagnosticsGeneration: number;
}

export class LspClient {
  private process?: ChildProcessWithoutNullStreams;
  private readonly framer = new MessageFramer();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly diagnostics = new Map<string, PublishedDiagnostics>();
  private readonly diagnosticsWaiters = new Map<string, Set<DiagnosticsWaiter>>();
  private readonly openDocuments = new Map<string, OpenDocument>();
  private readonly documentSyncQueues = new Map<string, Promise<SyncResult>>();
  private writeQueue: Promise<void> = Promise.resolve();
  private synchronization: SynchronizationOptions = { openClose: false, change: 0, save: false, includeTextOnSave: false };
  private nextId = 1;
  private diagnosticGeneration = 0;
  private stopping = false;
  private closing = false;
  private started = false;
  private stderr = "";
  lastActivity = Date.now();

  constructor(
    readonly resolved: ResolvedServer,
    private readonly defaultRequestTimeoutMs: number,
  ) {}

  get name(): string {
    return this.resolved.definition.name;
  }

  get root(): string {
    return this.resolved.root;
  }

  get definition(): ServerDefinition {
    return this.resolved.definition;
  }

  get isRunning(): boolean {
    return this.started && this.process?.exitCode === null && !this.stopping && !this.closing;
  }

  get stderrTail(): string {
    return this.stderr;
  }

  get isBusy(): boolean {
    return this.pending.size > 0 || this.diagnosticsWaiters.size > 0;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.started) return;
    this.started = true;
    const child = spawn(this.resolved.command, this.resolved.definition.args, {
      cwd: this.resolved.root,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.framer.push(chunk)) void this.handleMessage(message);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = cleanProcessText(`${this.stderr}${chunk.toString("utf8")}`).slice(-8_192);
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, processSignal) => {
      if (!this.stopping && !this.closing) {
        this.fail(new Error(`LSP server ${this.name} exited (${code ?? processSignal ?? "unknown"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
      }
    });

    try {
      const initializeResult = await this.request<{ capabilities?: { textDocumentSync?: unknown } }>(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "pi-lsp", version: "0.1.0" },
          rootUri: fileToUri(this.resolved.root),
          workspaceFolders: [{ uri: fileToUri(this.resolved.root), name: path.basename(this.resolved.root) || "workspace" }],
          capabilities: CLIENT_CAPABILITIES,
          initializationOptions: this.resolved.definition.initializationOptions,
        },
        { signal, timeoutMs: Math.max(5_000, this.defaultRequestTimeoutMs) },
      );
      this.synchronization = parseSynchronizationOptions(initializeResult.capabilities?.textDocumentSync);
      await this.notify("initialized", {});
      this.lastActivity = Date.now();
    } catch (error) {
      await this.forceStop();
      throw error;
    }
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    const child = this.process;
    if (!child || child.exitCode !== null || this.stopping) throw new Error(`LSP server ${this.name} is not running`);
    options.signal?.throwIfAborted();

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs;
    this.lastActivity = Date.now();

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        void this.notify("$/cancelRequest", { id }).catch(() => undefined);
        reject(new LspTimeoutError(`LSP request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      };
      this.pending.set(id, pending);
      if (options.signal) {
        const onAbort = () => {
          this.pending.delete(id);
          clearTimeout(timer);
          void this.notify("$/cancelRequest", { id }).catch(() => undefined);
          reject(options.signal?.reason instanceof Error ? options.signal.reason : new Error("LSP request cancelled"));
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.abort = () => options.signal?.removeEventListener("abort", onAbort);
        if (options.signal.aborted) onAbort();
      }
    });

    try {
      if (this.pending.has(id)) await this.send({ jsonrpc: "2.0", id, method, params });
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.abort?.();
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.lastActivity = Date.now();
    await this.send({ jsonrpc: "2.0", method, params });
  }

  diagnosticsGenerationFor(uri: string): number {
    return this.diagnostics.get(uri)?.generation ?? 0;
  }

  latestDiagnostics(uri: string): PublishedDiagnostics | undefined {
    return this.diagnostics.get(uri);
  }

  openDocumentText(filePath: string): string | undefined {
    return this.openDocuments.get(fileToUri(filePath))?.text;
  }

  openDocumentVersion(filePath: string): number | undefined {
    return this.openDocuments.get(fileToUri(filePath))?.version;
  }

  async syncFile(filePath: string): Promise<SyncResult> {
    const uri = fileToUri(filePath);
    const previous = this.documentSyncQueues.get(uri);
    const queued = (previous?.catch(() => undefined) ?? Promise.resolve()).then(() => this.syncFileNow(filePath, uri));
    this.documentSyncQueues.set(uri, queued);
    try {
      return await queued;
    } finally {
      if (this.documentSyncQueues.get(uri) === queued) this.documentSyncQueues.delete(uri);
    }
  }

  private async syncFileNow(filePath: string, uri: string): Promise<SyncResult> {
    if ((await stat(filePath)).size > 10 * 1024 * 1024) {
      throw new Error(`LSP document exceeds the 10MB safety limit: ${filePath}`);
    }
    const text = await readFile(filePath, "utf8");
    const beforeDiagnosticsGeneration = this.diagnosticsGenerationFor(uri);
    const current = this.openDocuments.get(uri);
    let changed = false;

    if (!current) {
      const document: OpenDocument = {
        text,
        version: 1,
        languageId: languageIdFor(this.resolved.definition, filePath),
      };
      this.openDocuments.set(uri, document);
      try {
        if (this.synchronization.openClose) {
          await this.notify("textDocument/didOpen", {
            textDocument: { uri, languageId: document.languageId, version: document.version, text },
          });
        }
      } catch (error) {
        this.openDocuments.delete(uri);
        throw error;
      }
      changed = true;
    } else if (current.text !== text) {
      const previousText = current.text;
      const previousVersion = current.version;
      current.text = text;
      current.version += 1;
      try {
        if (this.synchronization.change !== 0) {
          await this.notify("textDocument/didChange", {
            textDocument: { uri, version: current.version },
            contentChanges: [{ text }],
          });
        }
      } catch (error) {
        current.text = previousText;
        current.version = previousVersion;
        throw error;
      }
      changed = true;
    }

    if (this.synchronization.save) {
      await this.notify("textDocument/didSave", {
        textDocument: { uri },
        ...(this.synchronization.includeTextOnSave ? { text } : {}),
      });
    }
    return { uri, changed, documentVersion: this.openDocuments.get(uri)?.version ?? 1, beforeDiagnosticsGeneration };
  }

  waitForDiagnostics(
    uri: string,
    afterGeneration: number,
    expectedDocumentVersion: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<PublishedDiagnostics> {
    const current = this.diagnostics.get(uri);
    if (current && current.generation > afterGeneration && (current.version === undefined || current.version >= expectedDocumentVersion)) {
      return Promise.resolve(current);
    }
    signal?.throwIfAborted();

    return new Promise<PublishedDiagnostics>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeDiagnosticsWaiter(uri, waiter);
        reject(new LspTimeoutError(`LSP diagnostics timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter: DiagnosticsWaiter = { afterGeneration, expectedDocumentVersion, resolve, reject, timer };
      const waiters = this.diagnosticsWaiters.get(uri) ?? new Set<DiagnosticsWaiter>();
      waiters.add(waiter);
      this.diagnosticsWaiters.set(uri, waiters);
      if (signal) {
        const onAbort = () => {
          this.removeDiagnosticsWaiter(uri, waiter);
          reject(signal.reason instanceof Error ? signal.reason : new Error("LSP diagnostics cancelled"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        waiter.abort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      }
    });
  }

  async closeDocument(filePath: string): Promise<void> {
    const uri = fileToUri(filePath);
    if (!this.openDocuments.has(uri)) return;
    this.openDocuments.delete(uri);
    this.diagnostics.delete(uri);
    if (this.synchronization.openClose) await this.notify("textDocument/didClose", { textDocument: { uri } });
  }

  async shutdown(): Promise<void> {
    if (this.stopping || this.closing) return;
    this.closing = true;
    const child = this.process;
    if (!child || child.exitCode !== null) {
      this.stopping = true;
      this.fail(new Error(`LSP server ${this.name} shut down`));
      return;
    }

    try {
      await this.request("shutdown", null, { timeoutMs: 1_000 });
      this.stopping = true;
      await this.notify("exit", null);
    } catch {
      this.stopping = true;
      // The graceful shutdown is best-effort.
    }

    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
    this.fail(new Error(`LSP server ${this.name} shut down`));
  }

  private async forceStop(): Promise<void> {
    this.closing = true;
    this.stopping = true;
    if (this.process?.exitCode === null) this.process.kill("SIGKILL");
    this.fail(new Error(`LSP server ${this.name} stopped`));
  }

  private send(message: JsonRpcMessage): Promise<void> {
    const child = this.process;
    if (!child || child.exitCode !== null) return Promise.reject(new Error(`LSP server ${this.name} is not running`));
    const write = this.writeQueue.catch(() => undefined).then(() => writeMessage(child.stdin, message));
    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private async handleMessage(message: JsonRpcMessage): Promise<void> {
    if (message.method) {
      if (message.id !== undefined) await this.handleServerRequest(message);
      else this.handleNotification(message.method, message.params);
      return;
    }
    if (message.id === undefined) return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.abort?.();
    this.lastActivity = Date.now();
    if (message.error) pending.reject(new LspResponseError(message.error.message, message.error.code, message.error.data));
    else pending.resolve(message.result);
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics" || typeof params !== "object" || params === null) return;
    const payload = params as { uri?: unknown; diagnostics?: unknown; version?: unknown };
    if (typeof payload.uri !== "string" || !Array.isArray(payload.diagnostics)) return;

    const waiters = this.diagnosticsWaiters.get(payload.uri);
    const expectedUnversioned = waiters && waiters.size > 0
      ? Math.min(...[...waiters].map((waiter) => waiter.expectedDocumentVersion))
      : this.openDocuments.get(payload.uri)?.version;
    const published: PublishedDiagnostics = {
      diagnostics: payload.diagnostics.slice(0, 1_000).map(normalizedDiagnostic).filter((value): value is Diagnostic => value !== null),
      generation: ++this.diagnosticGeneration,
      version: typeof payload.version === "number" ? payload.version : expectedUnversioned,
    };
    this.diagnostics.set(payload.uri, published);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (published.generation <= waiter.afterGeneration || (published.version !== undefined && published.version < waiter.expectedDocumentVersion)) continue;
      this.removeDiagnosticsWaiter(payload.uri, waiter);
      waiter.resolve(published);
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    const method = message.method ?? "";
    let result: unknown = null;
    let error: { code: number; message: string } | undefined;

    if (method === "workspace/configuration") {
      const items = (message.params as { items?: Array<{ section?: string }> } | undefined)?.items ?? [];
      result = items.map((item) => this.resolved.definition.settings?.[item.section ?? ""] ?? null);
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: fileToUri(this.resolved.root), name: path.basename(this.resolved.root) || "workspace" }];
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Server-initiated workspace edits are disabled; use the lsp tool preview/apply flow" };
    } else if (method === "window/showDocument") {
      result = { success: false };
    } else if (
      method === "client/registerCapability" ||
      method === "client/unregisterCapability" ||
      method === "window/workDoneProgress/create" ||
      method === "window/showMessageRequest" ||
      method.endsWith("/refresh")
    ) {
      result = null;
    } else {
      error = { code: -32601, message: `Method not found: ${method}` };
    }

    await this.send({ jsonrpc: "2.0", id: message.id, ...(error ? { error } : { result }) }).catch(() => undefined);
  }

  private removeDiagnosticsWaiter(uri: string, waiter: DiagnosticsWaiter): void {
    clearTimeout(waiter.timer);
    waiter.abort?.();
    const waiters = this.diagnosticsWaiters.get(uri);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.diagnosticsWaiters.delete(uri);
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.abort?.();
      pending.reject(error);
    }
    this.pending.clear();
    for (const [uri, waiters] of this.diagnosticsWaiters) {
      for (const waiter of waiters) {
        this.removeDiagnosticsWaiter(uri, waiter);
        waiter.reject(error);
      }
    }
  }
}
