import { loadDiagramConfig, type DiagramConfig } from "./config.js";
import { DiagramService } from "./service.js";

export interface DiagramRuntimeOptions {
  loadConfig?: () => Promise<DiagramConfig>;
  createService?: (config: DiagramConfig) => DiagramService;
}

/** Serializes service replacement while leaving ordinary diagram operations outside the lifecycle queue. */
export class DiagramRuntimeController {
  private service: DiagramService | undefined;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private readonly loadConfig: () => Promise<DiagramConfig>;
  private readonly createService: (config: DiagramConfig) => DiagramService;

  constructor(options: DiagramRuntimeOptions = {}) {
    this.loadConfig = options.loadConfig ?? (() => loadDiagramConfig());
    this.createService = options.createService ?? ((config) => new DiagramService({ config }));
  }

  getService(): Promise<DiagramService> {
    return this.enqueue(async () => {
      if (!this.service) this.service = this.createService(await this.loadConfig());
      return this.service;
    });
  }

  transactConfig<T>(config: DiagramConfig, operation: (candidate: DiagramService) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      if (!this.service) this.service = this.createService(await this.loadConfig());
      const previousConfig: DiagramConfig = { hosting: { ...this.service.settings } };
      const previous = this.service;
      this.service = undefined;
      await previous.close();
      const candidate = this.createService(config);
      this.service = candidate;
      try {
        return await operation(candidate);
      } catch (error) {
        this.service = undefined;
        await candidate.close().catch(() => undefined);
        this.service = this.createService(previousConfig);
        throw error;
      }
    });
  }

  reset(): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.service;
      this.service = undefined;
      await previous?.close();
      this.service = this.createService(await this.loadConfig());
    });
  }

  shutdown(): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.service;
      this.service = undefined;
      await previous?.close();
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycle.catch(() => undefined).then(operation);
    this.lifecycle = next;
    return next;
  }
}
