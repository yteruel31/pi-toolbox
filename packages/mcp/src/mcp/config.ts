import type { McpConfig } from "../config.js";

export interface HttpServerConfig {
	name: string;
	url: URL;
	headers: Readonly<Record<string, string>>;
}
export interface ServerConfigDiagnostic {
	server: string;
	code: "unsafe-name" | "invalid-definition" | "unsupported-transport" | "unsafe-url" | "unsafe-header";
	message: string;
}
export interface ParsedServerConfigs {
	servers: Map<string, HttpServerConfig>;
	diagnostics: ServerConfigDiagnostic[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FORBIDDEN_HEADERS = new Set([
	"connection", "content-length", "cookie", "host", "keep-alive", "proxy-authenticate",
	"proxy-authorization", "set-cookie", "te", "trailer", "transfer-encoding", "upgrade",
]);
const HTTP_MARKERS = new Set(["http", "streamable-http", "streamable_http", "streamablehttp"]);
const SENSITIVE_QUERY = /^(?:token|secret|password|credential|signature|auth|api[-_]?key)$/i;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function report(server: string, code: ServerConfigDiagnostic["code"], message: string): ServerConfigDiagnostic {
	return { server, code, message };
}

/** Parses each opaque server independently. Diagnostics never include configured values. */
export function parseHttpServerConfigs(config: Pick<McpConfig, "mcpServers">): ParsedServerConfigs {
	const servers = new Map<string, HttpServerConfig>();
	const diagnostics: ServerConfigDiagnostic[] = [];
	for (const [name, value] of Object.entries(config.mcpServers)) {
		if (!NAME.test(name)) {
			diagnostics.push(report("<invalid>", "unsafe-name", "Server name was rejected"));
			continue;
		}
		if (!isObject(value) || typeof value.url !== "string") {
			diagnostics.push(report(name, "invalid-definition", "An HTTP URL is required"));
			continue;
		}
		const marker = value.type ?? value.transport;
		if (marker !== undefined && (typeof marker !== "string" || !HTTP_MARKERS.has(marker.toLowerCase()))) {
			diagnostics.push(report(name, "unsupported-transport", "Only Streamable HTTP is supported"));
			continue;
		}
		let url: URL;
		try { url = new URL(value.url); }
		catch {
			diagnostics.push(report(name, "unsafe-url", "URL was rejected"));
			continue;
		}
		const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
		const sensitiveQuery = [...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key));
		if (url.username || url.password || url.hash || sensitiveQuery ||
			(url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
			diagnostics.push(report(name, "unsafe-url", "URL security requirements were not met"));
			continue;
		}
		const headers: Record<string, string> = Object.create(null) as Record<string, string>;
		const seen = new Set<string>();
		let invalidHeaders = value.headers !== undefined && !isObject(value.headers);
		if (!invalidHeaders) {
			for (const [key, headerValue] of Object.entries((value.headers ?? {}) as Record<string, unknown>)) {
				const normalized = key.toLowerCase();
				if (typeof headerValue !== "string" || !HEADER_NAME.test(key) || seen.has(normalized) ||
					FORBIDDEN_HEADERS.has(normalized) || normalized.startsWith("sec-") || normalized.startsWith("proxy-")) {
					invalidHeaders = true;
					break;
				}
				seen.add(normalized);
				headers[key] = headerValue;
			}
		}
		if (invalidHeaders) {
			diagnostics.push(report(name, "unsafe-header", "Headers were rejected"));
			continue;
		}
		servers.set(name, { name, url, headers: Object.freeze(headers) });
	}
	return { servers, diagnostics };
}
