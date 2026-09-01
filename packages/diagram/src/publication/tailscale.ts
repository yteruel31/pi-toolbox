import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import type { DiagramHostingSettings } from "../config.js";

const execFile = promisify(execFileCallback);
const TIMEOUT_MS = 5_000;

export interface TailscaleExec { (args: readonly string[]): Promise<{ stdout: string }> }
export type TailscaleRouteState = "absent" | "matching" | "conflicting";
export class DiagramTailscaleMutationError extends Error {
  constructor(readonly operation: "setup" | "remove", readonly changed: boolean) {
    super(`Tailscale Serve ${operation} failed`);
  }
}

export class DiagramTailscaleAdapter {
  constructor(private readonly run: TailscaleExec = async (args) => execFile("tailscale", [...args], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
  })) {}

  async hostname(): Promise<string> {
    let stdout: string;
    try { ({ stdout } = await this.run(["status", "--json"])); }
    catch { throw new Error("Tailscale is unavailable"); }
    try {
      const value = JSON.parse(stdout) as { Self?: { DNSName?: unknown } };
      if (typeof value.Self?.DNSName !== "string" || !value.Self.DNSName.trim()) throw new Error();
      return value.Self.DNSName.replace(/\.$/, "");
    } catch { throw new Error("Malformed Tailscale status"); }
  }

  async status(settings: DiagramHostingSettings): Promise<{ state: TailscaleRouteState; target: string }> {
    const target = `http://127.0.0.1:${settings.port}`;
    let stdout: string;
    try { ({ stdout } = await this.run(["serve", "status", "--json"])); }
    catch { throw new Error("Tailscale is unavailable"); }
    let value: unknown;
    try { value = JSON.parse(stdout); }
    catch { throw new Error("Malformed Tailscale Serve status"); }
    const handler = selectedHandler(value, settings.httpsPort, settings.basePath);
    return { state: handler === undefined ? "absent" : handler === target ? "matching" : "conflicting", target };
  }

  async setup(settings: DiagramHostingSettings): Promise<{ changed: boolean }> {
    const before = await this.status(settings);
    if (before.state === "conflicting") throw new Error(`Tailscale Serve already uses ${settings.basePath} on HTTPS port ${settings.httpsPort}`);
    if (before.state === "matching") return { changed: false };
    let changed = false;
    try {
      changed = true;
      await this.safeRun(["serve", "--bg", `--https=${settings.httpsPort}`, `--set-path=${settings.basePath}`, before.target]);
      const after = await this.status(settings);
      if (after.state !== "matching") throw new Error("postcondition");
      return { changed };
    } catch {
      throw new DiagramTailscaleMutationError("setup", changed);
    }
  }

  async remove(settings: DiagramHostingSettings): Promise<{ changed: boolean }> {
    const before = await this.status(settings);
    if (before.state === "conflicting") throw new Error("Refusing to remove a Tailscale Serve route owned by another service");
    if (before.state === "absent") return { changed: false };
    let changed = false;
    try {
      changed = true;
      await this.safeRun(["serve", `--https=${settings.httpsPort}`, `--set-path=${settings.basePath}`, "off"]);
      const after = await this.status(settings);
      if (after.state !== "absent") throw new Error("postcondition");
      return { changed };
    } catch {
      throw new DiagramTailscaleMutationError("remove", changed);
    }
  }

  private async safeRun(args: readonly string[]): Promise<void> {
    try { await this.run(args); }
    catch { throw new Error("Tailscale command failed"); }
  }
}

function selectedHandler(value: unknown, port: number, basePath: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const web = (value as { Web?: unknown }).Web;
  if (!web || typeof web !== "object") return undefined;
  const routes = new Set([basePath, `${basePath}/`]);
  const selected: string[] = [];
  for (const [hostPort, server] of Object.entries(web)) {
    if (!hostPort.endsWith(`:${port}`) || !server || typeof server !== "object") continue;
    const handlers = (server as { Handlers?: unknown }).Handlers;
    if (!handlers || typeof handlers !== "object") continue;
    for (const route of routes) {
      const handler = (handlers as Record<string, unknown>)[route];
      if (handler === undefined) continue;
      const proxy = handler && typeof handler === "object" ? (handler as { Proxy?: unknown }).Proxy : undefined;
      selected.push(typeof proxy === "string" ? proxy : "<conflicting>");
    }
  }
  if (selected.length === 0) return undefined;
  return selected.every((handler) => handler === selected[0]) ? selected[0] : "<conflicting>";
}
