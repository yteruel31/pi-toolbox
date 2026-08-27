import * as path from "node:path";

import { loadConfig } from "./config.js";
import { DiagnosticLedger, MutationVersions } from "./diagnostics.js";
import { executeLspOperation, type LspToolInput } from "./operations.js";
import { LspRegistry } from "./registry.js";
import type { AggregatedDiagnostics, DiagnosticCardData, LspConfig, LspToolDetails } from "./types.js";

export interface LspServiceOptions {
  cwd: string;
  agentDir: string;
  configDirName: string;
  projectTrusted: boolean;
}

export class LspService {
  private registryValue?: LspRegistry;
  private configValue?: LspConfig;
  private readonly ledger = new DiagnosticLedger();
  private readonly mutations = new MutationVersions();

  constructor(readonly options: LspServiceOptions) {}

  get cwd(): string {
    return this.options.cwd;
  }

  get config(): LspConfig {
    if (!this.configValue) throw new Error("LSP service has not been initialized");
    return this.configValue;
  }

  get registry(): LspRegistry {
    if (!this.registryValue) throw new Error("LSP service has not been initialized");
    return this.registryValue;
  }

  async initialize(): Promise<void> {
    this.configValue = await loadConfig(this.options);
    this.registryValue = new LspRegistry(this.options.cwd, this.configValue, this.options.projectTrusted);
  }

  beginMutation(filePath: string): number {
    return this.mutations.begin(path.resolve(filePath));
  }

  isCurrentMutation(filePath: string, version: number): boolean {
    return this.mutations.isCurrent(path.resolve(filePath), version);
  }

  invalidateMutation(filePath: string, version: number): void {
    this.mutations.invalidate(path.resolve(filePath), version);
  }

  async diagnosticsAfterMutation(filePath: string, signal?: AbortSignal): Promise<AggregatedDiagnostics | null> {
    if (!this.config.diagnostics.enabled) return null;
    return this.registry.syncDiagnostics(filePath, this.config.diagnostics.deferredTimeoutMs, signal, "mutation");
  }

  makeDiagnosticCard(filePath: string, result: AggregatedDiagnostics, delayed: boolean): DiagnosticCardData | null {
    return this.ledger.update(
      this.cwd,
      filePath,
      result.servers.join(", "),
      result.diagnostics,
      this.config.diagnostics.maxDiagnostics,
      delayed,
      result.complete,
    );
  }

  async execute(input: LspToolInput, signal?: AbortSignal): Promise<LspToolDetails> {
    const result = await executeLspOperation(
      {
        cwd: this.cwd,
        registry: this.registry,
        reload: async () => {
          await this.reload();
          return this.registry;
        },
      },
      input,
      signal,
    );
    if (result.applied) this.mutations.clear();
    return result;
  }

  async reload(): Promise<void> {
    await this.registryValue?.shutdownAll();
    this.ledger.clear();
    this.mutations.clear();
    await this.initialize();
  }

  async shutdown(): Promise<void> {
    await this.registryValue?.shutdownAll();
    this.registryValue = undefined;
    this.configValue = undefined;
    this.ledger.clear();
    this.mutations.clear();
  }
}
