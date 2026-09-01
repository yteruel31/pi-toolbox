import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { DEFAULT_HOSTING_SETTINGS, parseDiagramConfig, writeDiagramConfig, type DiagramConfig } from "./config.js";
import type { DiagramService } from "./service.js";

export interface DiagramCommandDependencies {
  getService(): Promise<DiagramService>;
  transactConfig<T>(config: DiagramConfig, operation: (candidate: DiagramService) => Promise<T>): Promise<T>;
}

export function registerDiagramCommand(pi: ExtensionAPI, dependencies: DiagramCommandDependencies): void {
  pi.registerCommand("diagram", {
    description: "Configure and inspect diagram hosting: status, list, setup, diagnose, remove-tailscale",
    handler: async (rawArgs, ctx) => {
      try {
        const args = rawArgs.trim().split(/\s+/).filter(Boolean);
        const action = args.shift() ?? "status";
        if (action === "status") {
          const service = await dependencies.getService();
          const count = (await service.store.list()).length;
          ctx.ui.notify(`Diagram hosting: ${service.settings.mode} · ${service.settings.listenAddress}:${service.settings.port}${service.settings.basePath} · ${count} stored diagram${count === 1 ? "" : "s"}`, "info");
          return;
        }
        if (action === "list") {
          const service = await dependencies.getService();
          const host = await service.ensureHost();
          const documents = await service.store.list();
          ctx.ui.notify(documents.length ? documents.map((document) => `${document.id} · ${document.title} · ${host.urlFor(document)}`).join("\n") : "No stored diagrams.", "info");
          return;
        }
        if (action === "diagnose") {
          const service = await dependencies.getService();
          const result = await service.diagnose();
          ctx.ui.notify(`Diagram ${result.mode} publication verified: ${result.url}`, "info");
          return;
        }
        if (action === "remove-tailscale") {
          const service = await dependencies.getService();
          const changed = await service.removeTailscale();
          ctx.ui.notify(changed ? "Diagram Tailscale Serve route removed." : "Diagram Tailscale Serve route was already absent.", "info");
          return;
        }
        if (action === "setup") {
          const mode = args.shift();
          if (mode === "local") {
            const port = optionalPort(args.shift(), DEFAULT_HOSTING_SETTINGS.port);
            noExtra(args);
            const config = parseDiagramConfig({ hosting: { mode: "local", basePath: "/diagram", port } });
            const message = await activateConfig(dependencies, config, async (service) => {
              const host = await service.ensureHost();
              return { message: `Diagram local hosting ready: ${host.publicBaseUrl}` };
            });
            ctx.ui.notify(message, "info");
            return;
          }
          if (mode === "tailscale") {
            const httpsPort = optionalPort(args.shift(), DEFAULT_HOSTING_SETTINGS.httpsPort);
            const port = optionalPort(args.shift(), DEFAULT_HOSTING_SETTINGS.port);
            noExtra(args);
            const config = parseDiagramConfig({ hosting: { mode: "tailscale", basePath: "/diagram", port, httpsPort, hostname: "auto", requireTailscaleIdentity: true } });
            const message = await activateConfig(dependencies, config, async (service) => {
              const result = await service.setupTailscale();
              return {
                message: `Diagram Tailscale hosting ready: ${result.url}`,
                ...(result.changed ? { rollback: () => service.removeTailscale().then(() => undefined) } : {}),
              };
            });
            ctx.ui.notify(message, "info");
            return;
          }
          if (mode === "custom") {
            const externalUrl = args.shift();
            if (!externalUrl) throw new Error("Usage: /diagram setup custom <https-url> [listen-address] [port]");
            const url = new URL(externalUrl);
            const listenAddress = args.shift() ?? "127.0.0.1";
            const port = optionalPort(args.shift(), DEFAULT_HOSTING_SETTINGS.port);
            noExtra(args);
            const config = parseDiagramConfig({ hosting: { mode: "custom", basePath: url.pathname, port, listenAddress, externalUrl } });
            const message = await activateConfig(dependencies, config, async (service) => {
              const result = await service.diagnose();
              return { message: `Diagram custom hosting verified: ${result.url}` };
            });
            ctx.ui.notify(message, "info");
            return;
          }
          throw new Error("Usage: /diagram setup local [port] | tailscale [https-port] [port] | custom <https-url> [listen-address] [port]");
        }
        throw new Error(`Unknown diagram command: ${action}`);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });
}

async function activateConfig(
  dependencies: DiagramCommandDependencies,
  config: DiagramConfig,
  prepare: (service: DiagramService) => Promise<{ message: string; rollback?: () => Promise<void> }>,
): Promise<string> {
  return dependencies.transactConfig(config, async (candidate) => {
    let rollback: (() => Promise<void>) | undefined;
    try {
      const prepared = await prepare(candidate);
      rollback = prepared.rollback;
      await writeDiagramConfig(config);
      return prepared.message;
    } catch (error) {
      await rollback?.().catch(() => undefined);
      throw error;
    }
  });
}

function optionalPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Port must be between 1 and 65535");
  return port;
}

function noExtra(args: string[]): void {
  if (args.length) throw new Error(`Unexpected argument: ${args[0]}`);
}
