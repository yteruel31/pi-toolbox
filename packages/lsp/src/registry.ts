import * as path from "node:path";

import { LspClient } from "./client.js";
import { findProjectRoot, pathIsWithin, resolveExecutable, supportsFile } from "./paths.js";
import type { LspConfig, PublishedDiagnostics, ResolvedServer, ServerDefinition } from "./types.js";

interface InitFailure {
  at: number;
  message: string;
}

export interface ServerStatus {
  name: string;
  command: string;
  root?: string;
  available: boolean;
  running: boolean;
  error?: string;
}

function clientKey(server: ResolvedServer): string {
  return JSON.stringify([server.command, server.root, server.definition.args, server.definition.initializationOptions ?? null, server.definition.settings ?? null]);
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("LSP operation cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class LspRegistry {
  private readonly clients = new Map<string, LspClient>();
  private readonly clientLocks = new Map<string, Promise<LspClient>>();
  private readonly failures = new Map<string, InitFailure>();
  private readonly executableCache = new Map<string, Promise<string | null>>();
  private readonly shutdownTasks = new Set<Promise<void>>();
  private readonly lifecycleController = new AbortController();
  private idleSweep?: NodeJS.Timeout;
  private closed = false;

  constructor(
    readonly cwd: string,
    readonly config: LspConfig,
    readonly projectTrusted: boolean,
  ) {}

  async clientForFile(filePath: string, signal?: AbortSignal): Promise<LspClient | null> {
    if (this.closed || !this.projectTrusted || !pathIsWithin(this.cwd, filePath)) return null;
    const resolved = await this.resolveForFile(filePath);
    if (!resolved) return null;
    return this.getOrCreate(resolved, signal);
  }

  async syncDiagnostics(
    filePath: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ client: LspClient; diagnostics: PublishedDiagnostics } | null> {
    const client = await this.clientForFile(filePath, signal);
    if (!client) return null;
    signal?.throwIfAborted();
    const sync = await client.syncFile(filePath);
    signal?.throwIfAborted();
    if (!sync.changed) {
      const existing = client.latestDiagnostics(sync.uri);
      if (existing) return { client, diagnostics: existing };
    }
    const diagnostics = await client.waitForDiagnostics(
      sync.uri,
      sync.beforeDiagnosticsGeneration,
      sync.documentVersion,
      timeoutMs,
      signal,
    );
    return { client, diagnostics };
  }

  async prepareFile(filePath: string, signal?: AbortSignal): Promise<LspClient> {
    const client = await this.clientForFile(filePath, signal);
    if (!client) throw new Error(`No language server is available for ${path.relative(this.cwd, filePath)}`);
    signal?.throwIfAborted();
    await client.syncFile(filePath);
    signal?.throwIfAborted();
    return client;
  }

  async refreshFiles(filePaths: string[]): Promise<void> {
    const unique = [...new Set(filePaths.map((filePath) => path.resolve(filePath)))];
    await Promise.all(
      unique.flatMap((filePath) =>
        [...this.clients.values()]
          .filter((client) => supportsFile(client.definition, filePath) && pathIsWithin(client.root, filePath))
          .map((client) => client.syncFile(filePath).catch(() => undefined)),
      ),
    );
  }

  async status(): Promise<ServerStatus[]> {
    const statuses: ServerStatus[] = [];
    for (const definition of this.config.servers) {
      const runningClient = [...this.clients.values()].find((client) => client.name === definition.name && client.isRunning);
      const root = runningClient?.root ?? await this.rootForStatus(definition);
      const command = runningClient?.resolved.command ?? (root ? await this.resolveCommand(definition, root) : null);
      const key = command && root ? clientKey({ definition, command, root }) : undefined;
      const failure = key ? this.failures.get(key) : undefined;
      statuses.push({
        name: definition.name,
        command: definition.command,
        root: root ?? undefined,
        available: Boolean(command),
        running: Boolean(runningClient),
        error: failure?.message,
      });
    }
    return statuses;
  }

  async shutdownAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifecycleController.abort(new Error("LSP registry shut down"));
    if (this.idleSweep) {
      clearInterval(this.idleSweep);
      this.idleSweep = undefined;
    }
    await Promise.allSettled([...this.clientLocks.values()]);
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.clientLocks.clear();
    for (const client of clients) this.retire(client);
    await Promise.allSettled([...this.shutdownTasks]);
  }

  private async resolveForFile(filePath: string): Promise<ResolvedServer | null> {
    for (const definition of this.config.servers) {
      if (!supportsFile(definition, filePath)) continue;
      const root = await findProjectRoot(filePath, this.cwd, definition.rootMarkers);
      if (!root) continue;
      const command = await this.resolveCommand(definition, root);
      if (command) return { definition, command, root };
    }
    return null;
  }

  private resolveCommand(definition: ServerDefinition, root: string): Promise<string | null> {
    const key = `${definition.command}\0${root}`;
    let pending = this.executableCache.get(key);
    if (!pending) {
      pending = resolveExecutable(definition.command, root, this.cwd);
      this.executableCache.set(key, pending);
    }
    return pending;
  }

  private async rootForStatus(definition: ServerDefinition): Promise<string | null> {
    const extension = definition.fileTypes[0] ?? ".txt";
    return findProjectRoot(path.join(this.cwd, `__pi_lsp_status__${extension.startsWith(".") ? extension : `.${extension}`}`), this.cwd, definition.rootMarkers);
  }

  private async getOrCreate(resolved: ResolvedServer, signal?: AbortSignal): Promise<LspClient> {
    const key = clientKey(resolved);
    const existing = this.clients.get(key);
    if (existing?.isRunning) return existing;

    const failure = this.failures.get(key);
    if (failure && Date.now() - failure.at < this.config.initFailureBackoffMs) {
      throw new Error(`LSP server ${resolved.definition.name} is in backoff after an initialization failure: ${failure.message}`);
    }

    const locked = this.clientLocks.get(key);
    if (locked) return waitWithSignal(locked, signal);

    const pending = (async () => {
      const client = new LspClient(resolved, this.config.requestTimeoutMs);
      try {
        await client.start(this.lifecycleController.signal);
        if (this.closed) {
          await client.shutdown();
          throw new Error("LSP registry shut down during server initialization");
        }
        this.clients.set(key, client);
        this.failures.delete(key);
        this.ensureIdleSweep();
        return client;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.failures.set(key, { at: Date.now(), message });
        throw error;
      } finally {
        this.clientLocks.delete(key);
      }
    })();
    this.clientLocks.set(key, pending);
    return waitWithSignal(pending, signal);
  }

  private retire(client: LspClient): void {
    const task = client.shutdown().finally(() => this.shutdownTasks.delete(task));
    this.shutdownTasks.add(task);
  }

  private ensureIdleSweep(): void {
    if (this.idleSweep) return;
    const interval = Math.min(60_000, Math.max(1_000, Math.floor(this.config.idleTimeoutMs / 2)));
    this.idleSweep = setInterval(() => {
      const now = Date.now();
      for (const [key, client] of this.clients) {
        if (client.isBusy || now - client.lastActivity <= this.config.idleTimeoutMs) continue;
        this.clients.delete(key);
        this.retire(client);
      }
      if (this.clients.size === 0 && this.idleSweep) {
        clearInterval(this.idleSweep);
        this.idleSweep = undefined;
      }
    }, interval);
    this.idleSweep.unref();
  }
}
