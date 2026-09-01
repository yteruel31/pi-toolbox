import type { DiagramConfig, DiagramHostingSettings } from "./config.js";
import { verifyExternalPublication } from "./publication/verify.js";
import { DiagramTailscaleAdapter, DiagramTailscaleMutationError } from "./publication/tailscale.js";
import { DiagramHost } from "./server/host.js";
import { DiagramStore } from "./store.js";

export interface DiagramServiceOptions {
  config: DiagramConfig;
  store?: DiagramStore;
  tailscale?: DiagramTailscaleAdapter;
}

export class DiagramService {
  readonly store: DiagramStore;
  readonly settings: DiagramHostingSettings;
  private readonly tailscale: DiagramTailscaleAdapter;
  private host: DiagramHost | undefined;
  private hostStart: Promise<DiagramHost> | undefined;
  private closed = false;

  constructor(options: DiagramServiceOptions) {
    this.settings = options.config.hosting;
    this.store = options.store ?? new DiagramStore();
    this.tailscale = options.tailscale ?? new DiagramTailscaleAdapter();
  }

  async ensureHost(options: { allowUnconfiguredTailscale?: boolean } = {}): Promise<DiagramHost> {
    if (this.closed) throw new Error("Diagram service is closed");
    if (!this.hostStart) this.hostStart = this.startHost(options).catch((error) => {
      this.hostStart = undefined;
      throw error;
    });
    return this.hostStart;
  }

  notifyDeleted(id: string): void {
    this.host?.notifyDeleted(id);
  }

  async setupTailscale(): Promise<{ changed: boolean; url: string }> {
    if (this.settings.mode !== "tailscale") throw new Error("Diagram hosting is not configured for Tailscale");
    const host = await this.ensureHost({ allowUnconfiguredTailscale: true });
    let result: { changed: boolean };
    try {
      result = await this.tailscale.setup(this.settings);
    } catch (error) {
      if (error instanceof DiagramTailscaleMutationError && error.changed) await this.tailscale.remove(this.settings).catch(() => undefined);
      throw error;
    }
    try {
      await verifyExternalPublication(host.publicBaseUrl, host);
    } catch (error) {
      if (result.changed) await this.tailscale.remove(this.settings).catch(() => undefined);
      throw error;
    }
    return { changed: result.changed, url: host.publicBaseUrl };
  }

  async removeTailscale(): Promise<boolean> {
    if (this.settings.mode !== "tailscale") throw new Error("Diagram hosting is not configured for Tailscale");
    return (await this.tailscale.remove(this.settings)).changed;
  }

  async diagnose(): Promise<{ url: string; mode: string }> {
    const host = await this.ensureHost();
    await verifyExternalPublication(host.publicBaseUrl, host);
    return { url: host.publicBaseUrl, mode: this.settings.mode };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = this.hostStart;
    let host = this.host;
    if (pending) {
      try { host = await pending; }
      catch { /* A failed or superseded start has no listener left to close. */ }
    }
    this.host = undefined;
    this.hostStart = undefined;
    await host?.close();
  }

  private async startHost(options: { allowUnconfiguredTailscale?: boolean }): Promise<DiagramHost> {
    let externalBaseUrl: string | undefined;
    if (this.settings.mode === "custom") {
      externalBaseUrl = this.settings.externalUrl;
    } else if (this.settings.mode === "tailscale") {
      if (!options.allowUnconfiguredTailscale) {
        const route = await this.tailscale.status(this.settings);
        if (route.state !== "matching") throw new Error("Tailscale hosting is not configured; run /diagram setup tailscale");
      }
      const hostname = this.settings.hostname === "auto" ? await this.tailscale.hostname() : this.settings.hostname;
      const path = this.settings.basePath === "/" ? "" : this.settings.basePath;
      externalBaseUrl = `https://${hostname}${this.settings.httpsPort === 443 ? "" : `:${this.settings.httpsPort}`}${path}`;
    }
    const host = new DiagramHost({ settings: this.settings, store: this.store, ...(externalBaseUrl ? { externalBaseUrl } : {}) });
    await host.start();
    if (this.closed) {
      await host.close();
      throw new Error("Diagram service closed while the host was starting");
    }
    this.host = host;
    return host;
  }
}
