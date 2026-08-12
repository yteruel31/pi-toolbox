import { createHash } from "node:crypto";
import type { McpUiSettings } from "../config.js";

export const PROTOCOL_VERSION = 3;
export const INTERNAL_SECRET_HEADER = "x-pi-mcp-backend-secret";

export interface GatewayDaemonSettings {
	externalUrl: string;
	listenAddress: string;
	gatewayPort: number;
	basePath: string;
	requireTailscaleIdentity: boolean;
	idleTimeoutMs: number;
}

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
export function settingsSignature(settings: McpUiSettings | GatewayDaemonSettings): string {
	const canonical = "externalUrl" in settings ? {
		externalUrl: settings.externalUrl,
		listenAddress: settings.listenAddress,
		gatewayPort: settings.gatewayPort,
		basePath: settings.basePath,
		requireTailscaleIdentity: settings.requireTailscaleIdentity,
		idleTimeoutMs: settings.idleTimeoutMs,
	} : settings;
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export function isLoopbackOrigin(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" && url.hostname === "127.0.0.1" && /^\d+$/.test(url.port) &&
			url.pathname === "/" && !url.search && !url.hash && Number(url.port) >= 1 && Number(url.port) <= 65_535;
	} catch { return false; }
}
