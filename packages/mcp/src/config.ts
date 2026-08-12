import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface McpUiSettings {
	hostname: string;
	httpsPort: number;
	basePath: string;
	gatewayPort: number;
	requireTailscaleIdentity: boolean;
	idleTimeoutMs: number;
}

export type McpGatewaySettings =
	| { mode: "tailscale" }
	| { mode: "custom"; externalUrl: string; listenAddress: string };

export type DirectToolsSetting = boolean | readonly string[];
export interface McpServerControls {
	disabled?: boolean;
	directTools?: DirectToolsSetting;
}
export type McpServerDefinition = Record<string, unknown>;
export interface ConfigDiagnostic {
	source: string;
	code: "invalid-json" | "invalid-top-level" | "unsafe-key" | "invalid-ui" | "invalid-gateway" | "invalid-direct-tools" | "invalid-capability" | "invalid-server" | "read-error";
	path: string;
	message: string;
}
export interface McpConfig {
	mcpServers: Record<string, McpServerDefinition>;
	settings: { ui: McpUiSettings; gateway?: McpGatewaySettings; directTools?: boolean; sampling?: boolean; samplingAutoApprove?: boolean; elicitation?: boolean };
	diagnostics: ConfigDiagnostic[];
}

export const DEFAULT_UI_SETTINGS: Readonly<McpUiSettings> = Object.freeze({
	hostname: "auto",
	httpsPort: 8443,
	basePath: "/mcp-ui",
	gatewayPort: 19877,
	requireTailscaleIdentity: true,
	idleTimeoutMs: 300_000,
});

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const CONTROL_KEYS = new Set(["disabled", "directTools"]);
const UI_KEYS = new Set(Object.keys(DEFAULT_UI_SETTINGS));
const MIN_IDLE_TIMEOUT_MS = 15_000;
const MAX_IDLE_TIMEOUT_MS = 86_400_000;
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
};

function unsafePath(value: unknown, path = "$"): string | undefined {
	if (!isPlainObject(value) && !Array.isArray(value)) return undefined;
	for (const key of Object.keys(value)) {
		if (UNSAFE_KEYS.has(key)) return `${path}.${key}`;
		const nested = unsafePath((value as Record<string, unknown>)[key], `${path}.${key}`);
		if (nested) return nested;
	}
	return undefined;
}

function isControlOverlay(value: Record<string, unknown>): boolean {
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => CONTROL_KEYS.has(key));
}

export function normalizeBasePath(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.length > 1 ? value.replace(/\/+$/, "") : value;
	if (normalized === "/") return normalized;
	if (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(normalized)) return undefined;
	if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
	return normalized;
}
function validHostname(value: unknown): value is string {
	if (value === "auto") return true;
	if (typeof value !== "string" || value.length > 253 || value.endsWith(".")) return false;
	return value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
const validPort = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65_535;

export function parseGatewaySettings(value: unknown): McpGatewaySettings | undefined {
	if (!isPlainObject(value) || unsafePath(value)) return undefined;
	if (value.mode === "tailscale") {
		return Object.keys(value).length === 1 ? { mode: "tailscale" } : undefined;
	}
	if (value.mode !== "custom" || Object.keys(value).some((key) => !["mode", "externalUrl", "listenAddress"].includes(key)) ||
		typeof value.externalUrl !== "string" || value.externalUrl.length > 2_048 ||
		typeof value.listenAddress !== "string" || isIP(value.listenAddress) === 0) return undefined;
	let parsed: URL;
	try { parsed = new URL(value.externalUrl); } catch { return undefined; }
	if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
	const basePath = normalizeBasePath(parsed.pathname);
	if (!basePath) return undefined;
	return {
		mode: "custom",
		externalUrl: `${parsed.origin}${basePath === "/" ? "" : basePath}`,
		listenAddress: value.listenAddress,
	};
}

export function parseDirectTools(value: unknown): DirectToolsSetting | undefined {
	if (typeof value === "boolean") return value;
	if (!Array.isArray(value) || value.length > 100 || !value.every((item) => typeof item === "string" && item.length > 0 && item.length <= 256) || new Set(value).size !== value.length) return undefined;
	return Object.freeze([...value]);
}

function parseUi(value: unknown, base: McpUiSettings): McpUiSettings | undefined {
	if (!isPlainObject(value) || unsafePath(value) || Object.keys(value).some((key) => !UI_KEYS.has(key))) return undefined;
	const candidate = { ...base, ...value };
	const basePath = normalizeBasePath(candidate.basePath);
	if (!validHostname(candidate.hostname) || !validPort(candidate.httpsPort) || !basePath ||
		!validPort(candidate.gatewayPort) || typeof candidate.requireTailscaleIdentity !== "boolean" ||
		!Number.isInteger(candidate.idleTimeoutMs) || candidate.idleTimeoutMs < MIN_IDLE_TIMEOUT_MS || candidate.idleTimeoutMs > MAX_IDLE_TIMEOUT_MS) return undefined;
	return { ...candidate, basePath } as McpUiSettings;
}

export function getMcpConfigPaths(home = homedir()): readonly [string, string] {
	return [join(home, ".config", "mcp", "mcp.json"), join(home, ".pi", "agent", "mcp.json")];
}

export function loadMcpConfig(options: { homeDir?: string; paths?: readonly string[] } = {}): McpConfig {
	const diagnostics: ConfigDiagnostic[] = [];
	const mcpServers: Record<string, McpServerDefinition> = Object.create(null) as Record<string, McpServerDefinition>;
	let ui = { ...DEFAULT_UI_SETTINGS };
	let gateway: McpGatewaySettings | undefined;
	let directTools = false;
	let sampling: boolean | undefined;
	let samplingAutoApprove: boolean | undefined;
	let elicitation: boolean | undefined;
	const paths = options.paths ?? getMcpConfigPaths(options.homeDir);
	const report = (source: string, code: ConfigDiagnostic["code"], path: string, message: string): void => {
		diagnostics.push({ source, code, path, message });
	};

	for (const [sourceIndex, source] of paths.entries()) {
		let text: string;
		try { text = readFileSync(source, "utf8"); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") report(source, "read-error", "$", "Configuration file could not be read");
			continue;
		}
		let layer: unknown;
		try { layer = JSON.parse(text); }
		catch { report(source, "invalid-json", "$", "Configuration file is not valid JSON"); continue; }
		if (!isPlainObject(layer)) { report(source, "invalid-top-level", "$", "Configuration root must be an object"); continue; }
		for (const key of Object.keys(layer)) if (UNSAFE_KEYS.has(key)) report(source, "unsafe-key", `$.${key}`, "Unsafe key was rejected");

		if (layer.mcpServers !== undefined) {
			if (!isPlainObject(layer.mcpServers)) report(source, "invalid-top-level", "$.mcpServers", "mcpServers must be an object");
			else for (const [name, server] of Object.entries(layer.mcpServers)) {
				const unsafe = UNSAFE_KEYS.has(name) ? `$.mcpServers.${name}` : unsafePath(server, `$.mcpServers.${name}`);
				if (unsafe) { report(source, "unsafe-key", unsafe, "Unsafe server key was rejected"); continue; }
				if (!isPlainObject(server)) { report(source, "invalid-server", `$.mcpServers.${name}`, "Server definition must be an object"); continue; }
				// A higher layer may manage an existing server without copying its transport or credentials.
				// Definitions containing url/command keep the documented whole-entry replacement behavior.
				mcpServers[name] = mcpServers[name] && isControlOverlay(server)
					? { ...mcpServers[name], ...server }
					: server;
			}
		}
		if (layer.settings !== undefined) {
			if (!isPlainObject(layer.settings) || unsafePath(layer.settings)) report(source, "invalid-ui", "$.settings", "Settings layer was rejected");
			else {
				if (layer.settings.ui !== undefined) {
					const parsed = parseUi(layer.settings.ui, ui);
					if (parsed) ui = parsed;
					else report(source, "invalid-ui", "$.settings.ui", "UI settings layer was rejected");
				}
				if (layer.settings.gateway !== undefined) {
					if (sourceIndex !== paths.length - 1) report(source, "invalid-gateway", "$.settings.gateway", "Gateway settings are accepted only from the Pi-owned configuration layer");
					else {
						const parsed = parseGatewaySettings(layer.settings.gateway);
						if (parsed) gateway = parsed;
						else report(source, "invalid-gateway", "$.settings.gateway", "Gateway settings layer was rejected");
					}
				}
				if (layer.settings.directTools !== undefined) {
					const parsed = parseDirectTools(layer.settings.directTools);
					if (typeof parsed === "boolean") directTools = parsed;
					else report(source, "invalid-direct-tools", "$.settings.directTools", "Direct tools setting was rejected");
				}
				for (const key of ["sampling", "samplingAutoApprove", "elicitation"] as const) {
					const value = layer.settings[key];
					if (value === undefined) continue;
					if (typeof value === "boolean") {
						if (key === "sampling") sampling = value;
						else if (key === "samplingAutoApprove") samplingAutoApprove = value;
						else elicitation = value;
					} else report(source, "invalid-capability", `$.settings.${key}`, "Capability setting must be boolean");
				}
			}
		}
	}
	return { mcpServers, settings: { ui, gateway, directTools, sampling, samplingAutoApprove, elicitation }, diagnostics };
}
