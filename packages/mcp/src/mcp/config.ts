import type { McpConfig } from "../config.js";

export interface UrlServerConfig {
	name: string;
	transport?: "http" | "sse" | "auto";
	url: URL;
	headers: Readonly<Record<string, string>>;
}
export interface StdioServerConfig {
	name: string;
	transport: "stdio";
	command: string;
	args?: readonly string[];
	env?: Readonly<Record<string, string>>;
	cwd?: string;
}
export type ServerConfig = UrlServerConfig | StdioServerConfig;
/** Compatibility alias for consumers which construct a URL config. */
export type HttpServerConfig = UrlServerConfig;
export interface ServerConfigDiagnostic {
	server: string;
	code: "unsafe-name" | "invalid-definition" | "unsupported-transport" | "unsafe-url" | "unsafe-header";
	message: string;
}
export interface ParsedServerConfigs { servers: Map<string, ServerConfig>; diagnostics: ServerConfigDiagnostic[]; }

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set(["connection", "content-length", "cookie", "host", "keep-alive", "proxy-authenticate", "proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade"]);
const HTTP_MARKERS = new Set(["http", "streamable-http", "streamable_http", "streamablehttp"]);
const SSE_MARKERS = new Set(["sse", "legacy-sse", "legacy_sse"]);
const SENSITIVE_QUERY = /^(?:token|secret|password|credential|signature|auth|api[-_]?key)$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const report = (server: string, code: ServerConfigDiagnostic["code"], message: string): ServerConfigDiagnostic => ({ server, code, message });
const onlyFields = (value: Record<string, unknown>, allowed: Set<string>) => Object.keys(value).every((key) => allowed.has(key));

/** Parses each opaque server independently. Diagnostics never include configured values. */
export function parseServerConfigs(config: Pick<McpConfig, "mcpServers">): ParsedServerConfigs {
	const servers = new Map<string, ServerConfig>();
	const diagnostics: ServerConfigDiagnostic[] = [];
	for (const [name, value] of Object.entries(config.mcpServers)) {
		if (!NAME.test(name)) { diagnostics.push(report("<invalid>", "unsafe-name", "Server name was rejected")); continue; }
		if (!isObject(value)) { diagnostics.push(report(name, "invalid-definition", "Server definition was rejected")); continue; }
		const hasUrl = "url" in value;
		const hasCommand = "command" in value;
		if (hasUrl === hasCommand) { diagnostics.push(report(name, "invalid-definition", "Exactly one transport source is required")); continue; }
		const marker = value.type ?? value.transport;
		if (hasCommand) {
			if (!onlyFields(value, new Set(["command", "args", "env", "cwd", "type", "transport"])) ||
				marker !== undefined && (typeof marker !== "string" || marker.toLowerCase() !== "stdio") ||
				typeof value.command !== "string" || value.command.length === 0 ||
				value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string")) ||
				value.cwd !== undefined && (typeof value.cwd !== "string" || value.cwd.length === 0) ||
				value.env !== undefined && (!isObject(value.env) || !Object.values(value.env).every((item) => typeof item === "string"))) {
				diagnostics.push(report(name, "invalid-definition", "Stdio definition was rejected")); continue;
			}
			servers.set(name, { name, transport: "stdio", command: value.command, args: value.args as string[] | undefined,
				env: value.env as Record<string, string> | undefined, cwd: value.cwd as string | undefined });
			continue;
		}
		if (!onlyFields(value, new Set(["url", "headers", "type", "transport"])) || typeof value.url !== "string") {
			diagnostics.push(report(name, "invalid-definition", "URL definition was rejected")); continue;
		}
		let transport: UrlServerConfig["transport"] = "auto";
		if (marker !== undefined) {
			if (typeof marker !== "string") { diagnostics.push(report(name, "unsupported-transport", "Transport was rejected")); continue; }
			const normalized = marker.toLowerCase();
			if (HTTP_MARKERS.has(normalized)) transport = "http";
			else if (SSE_MARKERS.has(normalized)) transport = "sse";
			else { diagnostics.push(report(name, "unsupported-transport", "Transport was rejected")); continue; }
		}
		let url: URL; try { url = new URL(value.url); } catch { diagnostics.push(report(name, "unsafe-url", "URL was rejected")); continue; }
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
		if (url.username || url.password || url.hash || [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key)) || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
			diagnostics.push(report(name, "unsafe-url", "URL security requirements were not met")); continue;
		}
		const headers: Record<string, string> = Object.create(null) as Record<string, string>; const seen = new Set<string>();
		let invalid = value.headers !== undefined && !isObject(value.headers);
		if (!invalid) for (const [key, item] of Object.entries((value.headers ?? {}) as Record<string, unknown>)) {
			const normalized = key.toLowerCase();
			if (typeof item !== "string" || !HEADER_NAME.test(key) || seen.has(normalized) || FORBIDDEN_HEADERS.has(normalized) || normalized.startsWith("sec-") || normalized.startsWith("proxy-")) { invalid = true; break; }
			seen.add(normalized); headers[key] = item;
		}
		if (invalid) { diagnostics.push(report(name, "unsafe-header", "Headers were rejected")); continue; }
		servers.set(name, { name, transport, url, headers: Object.freeze(headers) });
	}
	return { servers, diagnostics };
}
export const parseHttpServerConfigs = parseServerConfigs;
