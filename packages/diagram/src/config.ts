import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export type HostingMode = "local" | "tailscale" | "custom";
export interface DiagramHostingSettings {
  mode: HostingMode;
  basePath: string;
  port: number;
  listenAddress: string;
  httpsPort: number;
  hostname: string;
  requireTailscaleIdentity: boolean;
  externalUrl?: string;
}
export interface DiagramConfig { hosting: DiagramHostingSettings }

export const DEFAULT_HOSTING_SETTINGS: Readonly<DiagramHostingSettings> = Object.freeze({
  mode: "local",
  basePath: "/diagram",
  port: 19_878,
  listenAddress: "127.0.0.1",
  httpsPort: 8_443,
  hostname: "auto",
  requireTailscaleIdentity: true,
});

export function diagramConfigPath(home = homedir()): string {
  return join(home, ".pi", "agent", "diagram.json");
}

export async function loadDiagramConfig(options: { homeDir?: string; path?: string } = {}): Promise<DiagramConfig> {
  const path = options.path ?? diagramConfigPath(options.homeDir);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { hosting: { ...DEFAULT_HOSTING_SETTINGS } };
    throw new Error(`Diagram configuration could not be read: ${path}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Diagram configuration is not valid JSON: ${path}`); }
  return parseDiagramConfig(value);
}

export function parseDiagramConfig(value: unknown): DiagramConfig {
  const root = plainObject(value, "configuration");
  exactKeys(root, ["hosting"], "configuration");
  const hosting = plainObject(root.hosting, "hosting");
  exactKeys(hosting, ["mode", "basePath", "port", "listenAddress", "httpsPort", "hostname", "requireTailscaleIdentity", "externalUrl"], "hosting");
  const mode = hosting.mode;
  if (mode !== "local" && mode !== "tailscale" && mode !== "custom") throw new Error("hosting.mode must be local, tailscale, or custom");
  const basePath = normalizeBasePath(hosting.basePath ?? DEFAULT_HOSTING_SETTINGS.basePath);
  const port = integer(hosting.port ?? DEFAULT_HOSTING_SETTINGS.port, "hosting.port", mode === "local" ? 0 : 1, 65_535);
  const listenAddress = hosting.listenAddress ?? (mode === "custom" ? "127.0.0.1" : DEFAULT_HOSTING_SETTINGS.listenAddress);
  if (typeof listenAddress !== "string" || isIP(listenAddress) === 0) throw new Error("hosting.listenAddress must be an IP address");
  if (mode !== "custom" && listenAddress !== "127.0.0.1" && listenAddress !== "::1") throw new Error(`${mode} mode must listen on loopback`);
  const httpsPort = integer(hosting.httpsPort ?? DEFAULT_HOSTING_SETTINGS.httpsPort, "hosting.httpsPort", 1, 65_535);
  const hostname = hosting.hostname ?? DEFAULT_HOSTING_SETTINGS.hostname;
  if (!validHostname(hostname)) throw new Error("hosting.hostname is invalid");
  const requireTailscaleIdentity = hosting.requireTailscaleIdentity ?? DEFAULT_HOSTING_SETTINGS.requireTailscaleIdentity;
  if (typeof requireTailscaleIdentity !== "boolean") throw new Error("hosting.requireTailscaleIdentity must be boolean");

  let externalUrl: string | undefined;
  if (mode === "custom") {
    externalUrl = normalizeExternalUrl(hosting.externalUrl, basePath);
  } else if (hosting.externalUrl !== undefined) {
    throw new Error("hosting.externalUrl is accepted only in custom mode");
  }
  if (mode !== "tailscale" && hosting.hostname !== undefined) throw new Error("hosting.hostname is accepted only in tailscale mode");
  if (mode !== "tailscale" && hosting.httpsPort !== undefined) throw new Error("hosting.httpsPort is accepted only in tailscale mode");
  if (mode !== "tailscale" && hosting.requireTailscaleIdentity !== undefined) throw new Error("hosting.requireTailscaleIdentity is accepted only in tailscale mode");

  return { hosting: { mode, basePath, port, listenAddress, httpsPort, hostname, requireTailscaleIdentity, ...(externalUrl ? { externalUrl } : {}) } };
}

export async function writeDiagramConfig(config: DiagramConfig, path = diagramConfigPath()): Promise<void> {
  const parsed = parseDiagramConfig(configToJson(config));
  await withFileMutationQueue(path, async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await chmod(dirname(path), 0o700);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(configToJson(parsed), null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

export function configToJson(config: DiagramConfig): Record<string, unknown> {
  const { hosting } = config;
  const common: Record<string, unknown> = { mode: hosting.mode, basePath: hosting.basePath, port: hosting.port };
  if (hosting.mode === "tailscale") {
    Object.assign(common, { httpsPort: hosting.httpsPort, hostname: hosting.hostname, requireTailscaleIdentity: hosting.requireTailscaleIdentity });
  } else if (hosting.mode === "custom") {
    Object.assign(common, { listenAddress: hosting.listenAddress, externalUrl: hosting.externalUrl });
  }
  return { hosting: common };
}

export function normalizeBasePath(value: unknown): string {
  if (typeof value !== "string") throw new Error("hosting.basePath must be a path");
  const normalized = value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (normalized !== "/" && (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized) || normalized.split("/").some((part) => part === "." || part === ".."))) {
    throw new Error("hosting.basePath is invalid");
  }
  return normalized;
}

function normalizeExternalUrl(value: unknown, basePath: string): string {
  if (typeof value !== "string" || value.length > 2_048) throw new Error("hosting.externalUrl is required in custom mode");
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("hosting.externalUrl must be a valid URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("hosting.externalUrl must be a credential-free HTTPS URL");
  const path = normalizeBasePath(url.pathname || "/");
  if (path !== basePath) throw new Error(`hosting.externalUrl must end at the configured basePath (${basePath})`);
  return `${url.origin}${basePath === "/" ? "" : basePath}`;
}

function plainObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowedKeys: string[], path: string): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key) || key === "__proto__" || key === "prototype" || key === "constructor");
  if (unknown) throw new Error(`${path}.${unknown} is not supported`);
}

function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) throw new Error(`${path} must be between ${minimum} and ${maximum}`);
  return value as number;
}

function validHostname(value: unknown): value is string {
  if (value === "auto") return true;
  return typeof value === "string" && value.length <= 253 && !value.endsWith(".") && value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
