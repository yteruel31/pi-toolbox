import { buildAllowAttribute } from "@modelcontextprotocol/ext-apps/app-bridge";
type McpUiResourcePermissions = NonNullable<Parameters<typeof buildAllowAttribute>[0]>;

export const MAX_RESOURCE_BYTES = 512 * 1024;
export const MAX_CONTROL_BYTES = 32 * 1024;
export const MAX_SESSION_DATA_BYTES = 2 * 1024 * 1024;
export const MAX_SESSION_MESSAGES_BYTES = 256 * 1024;
export const securityHeaders = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
} as const;

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function validOrigins(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const origins = value.flatMap((item) => {
		if (typeof item !== "string" || item.length > 512 || /[\u0000-\u0020\u007f-\u009f]/u.test(item)) return [];
		try {
			const wildcard = /^https:\/\/\*\./iu.test(item);
			const parsed = new URL(wildcard ? item.replace(/^https:\/\/\*\./iu, "https://wildcard.") : item);
			if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return [];
			if (!wildcard) return parsed.hostname.includes("*") ? [] : [parsed.origin];
			if (parsed.protocol !== "https:" || !parsed.hostname.startsWith("wildcard.")) return [];
			const hostname = parsed.hostname.slice("wildcard.".length);
			if (!hostname || hostname.includes("*")) return [];
			return [`https://*.${hostname}${parsed.port ? `:${parsed.port}` : ""}`];
		} catch {
			return [];
		}
	});
	return [...new Set(origins)];
}

export function normalizeMeta(meta: unknown): { csp: string; permissions?: McpUiResourcePermissions; allow: string; prefersBorder: boolean; domain?: string } {
	const root = meta && typeof meta === "object" ? meta as Record<string, unknown> : {};
	const ui = root.ui && typeof root.ui === "object" ? root.ui as Record<string, unknown> : {};
	const hasCanonical = Object.prototype.hasOwnProperty.call(ui, "csp");
	const canonical = ui.csp && typeof ui.csp === "object" ? ui.csp as Record<string, unknown> : {};
	const legacy = root["openai/widgetCSP"] && typeof root["openai/widgetCSP"] === "object" ? root["openai/widgetCSP"] as Record<string, unknown> : {};
	const connect = validOrigins(hasCanonical ? canonical.connectDomains : legacy.connect_domains);
	const resources = validOrigins(hasCanonical ? canonical.resourceDomains : legacy.resource_domains);
	const frames = validOrigins(hasCanonical ? canonical.frameDomains : legacy.frame_domains);
	const baseUris = validOrigins(hasCanonical ? canonical.baseUriDomains : undefined);
	const permissionRoot = ui.permissions && typeof ui.permissions === "object" && !Array.isArray(ui.permissions) ? ui.permissions as Record<string, unknown> : {};
	const allowedPermissions = new Set(["camera", "microphone", "geolocation", "clipboardWrite"]);
	const cleanPermissions = Object.fromEntries(Object.entries(permissionRoot).filter(([key, value]) => allowedPermissions.has(key) && value !== null && typeof value === "object" && !Array.isArray(value))) as McpUiResourcePermissions;
	const permissions = Object.keys(cleanPermissions).length ? cleanPermissions : undefined;
	const domain = validOrigins([ui.domain]).find((origin) => !origin.includes("*"));
	return {
		csp: `default-src 'none'; base-uri ${baseUris.length ? baseUris.join(" ") : "'self'"}; object-src 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'self' 'unsafe-inline' ${resources.join(" ")}; style-src 'self' 'unsafe-inline' ${resources.join(" ")}; font-src 'self' ${resources.join(" ")}; media-src 'self' data: ${resources.join(" ")}; img-src 'self' data: ${resources.join(" ")}; connect-src 'self' ${connect.join(" ")}; frame-src ${frames.length ? frames.join(" ") : "'none'"}; worker-src 'self' blob: ${resources.join(" ")}`,
		permissions, allow: permissions ? buildAllowAttribute(permissions) : "", prefersBorder: ui.prefersBorder === true, ...(domain ? { domain } : {}),
	};
}

export function boundedJson(value: unknown, max = MAX_CONTROL_BYTES): unknown {
	const encoded = JSON.stringify(value);
	if (encoded === undefined || Buffer.byteLength(encoded) > max) throw new Error("App data exceeds limit");
	return JSON.parse(encoded);
}
