import { createHash } from "node:crypto";
import type { McpUiSettings } from "../config.js";

export const PROTOCOL_VERSION = 1;
export const INTERNAL_SECRET_HEADER = "x-pi-mcp-backend-secret";

export interface Registration {
	label: string;
	backendOrigin: string;
	backendSecret?: string;
}
export interface Session {
	sessionId: string;
	capability: string;
	leaseSecret: string;
	externalUrl: string;
}
export function settingsSignature(settings: McpUiSettings): string {
	return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
export function isLoopbackOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && /^\d+$/.test(url.port) &&
			url.pathname === "/" && !url.search && !url.hash && Number(url.port) >= 1 && Number(url.port) <= 65_535;
	} catch { return false; }
}
