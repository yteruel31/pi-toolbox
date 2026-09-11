/** Only allowlisted facts cross the gateway's UI/model boundary. Never serialize raw errors. */
const causes = {
	unconfigured: ["Publication is not configured.", "Choose Tailscale or Custom in /mcp > Gateway."],
	"invalid-config": ["Gateway configuration is invalid.", "Check the HTTPS base URL and IP listener; don't overwrite the configuration file."],
	"tailscale-missing": ["The Tailscale CLI is not installed.", "Ask whether to install Tailscale or use a custom proxy."],
	"tailscale-unavailable": ["Tailscale could not be queried.", "Inspect the Tailscale daemon and login state before proposing changes."],
	"permission-denied": ["The operation was denied by the operating system.", "Inspect file or Tailscale operator permissions; ask before changing them."],
	"tailscale-status-invalid": ["Tailscale returned an unsupported status.", "Check the CLI version and daemon status locally; don't share raw output."],
	"hostname-unavailable": ["The Tailscale DNS hostname is unavailable.", "Check Tailscale login and MagicDNS configuration."],
	"route-absent": ["The exact Tailscale Serve route is missing.", "Use /mcp > Gateway to configure the managed route after confirmation."],
	"route-conflict": ["Another handler owns the requested Tailscale route.", "Inspect its owner and agree on a different route or proxy; don't replace it."],
	"route-mutation-failed": ["The exact route change could not be verified.", "Inspect the route state before retrying; unrelated routes must stay unchanged."],
	"daemon-owner-live": ["The recorded gateway owner is still alive.", "Inspect that process before retrying; don't delete its PID or socket while it is alive."],
	"session-unavailable": ["The gateway session was not found or its lease was rejected.", "Restart the affected App or OAuth flow to obtain a fresh session."],
	"daemon-unavailable": ["The local gateway daemon is unavailable.", "Inspect the gateway listener, launch lock, and recorded process owner."],
	"daemon-incompatible": ["The resident gateway protocol or settings are incompatible.", "Wait for active sessions to finish, then retry configuration; don't kill an unknown owner."],
	"active-sessions": ["Other gateway sessions prevent shutdown.", "Let the other Pi sessions finish or close their Apps/OAuth flows, then retry."],
	"dns-failed": ["The external HTTPS hostname could not be resolved.", "Check DNS and whether this host can resolve the selected private or public domain."],
	"tls-failed": ["The external TLS certificate could not be verified.", "Check the certificate chain and hostname; don't disable TLS verification."],
	"connection-refused": ["The HTTPS endpoint refused the connection.", "Check the proxy listener, port, and network policy."],
	"request-timeout": ["The gateway request timed out.", "Check the daemon, proxy target, firewall, and reachability from this host."],
	"https-denied": ["The external endpoint denied the validation request.", "Check proxy access policy and, in Tailscale mode, injected user identity."],
	"https-route-missing": ["The external capability route returned not found.", "Check path preservation and proxy target; in Tailscale mode also check identity injection."],
	"https-upstream-failed": ["The reverse proxy could not reach its upstream.", "Check that the proxy can reach the configured gateway IP and port."],
	"challenge-mismatch": ["The external endpoint did not return the exact gateway challenge.", "Check path rewriting, redirects, caching, and the proxy target. Don't save until validation passes."],
	"external-validation-failed": ["The external HTTPS challenge failed.", "Check DNS, TLS, routing, and access policy; retry validation after an agreed repair."],
	"persistence-failed": ["Validated configuration could not be saved.", "Check the Pi configuration's permissions, validity, and lock owner. Don't bypass its writer."],
	"runtime-changed": ["The Pi runtime changed during maintenance.", "Retry from the current session after it finishes starting."],
	"runtime-restore-failed": ["MCP connections could not be restored after maintenance.", "Run /reload before using MCP servers again."],
	"configuration-changed": ["Gateway settings changed while awaiting confirmation.", "Review the current settings and retry confirmation."],
	cancelled: ["The operation was cancelled.", "No further changes will be attempted; inspect rollback status before retrying."],
	unknown: ["The gateway operation failed.", "Inspect the failing step locally, without sharing credentials or raw command output."],
} as const;

export type GatewayDiagnosticCode = keyof typeof causes;
export type GatewayStep = "configuration" | "confirmation" | "quiesce" | "daemon-stop" | "daemon-start" | "tailscale-route" | "external-https" | "persistence" | "runtime-restore";
export interface GatewayDiagnostic { step: GatewayStep; code: GatewayDiagnosticCode; summary: string; nextAction: string; }
export class GatewayDiagnosticError extends Error {
	constructor(readonly code: GatewayDiagnosticCode) { super(causes[code][0]); }
}
export function gatewayDiagnostic(step: GatewayStep, code: GatewayDiagnosticCode): GatewayDiagnostic {
	const safeCode = Object.hasOwn(causes, code) ? code : "unknown";
	const safeStep = ["configuration", "confirmation", "quiesce", "daemon-stop", "daemon-start", "tailscale-route", "external-https", "persistence", "runtime-restore"].includes(step) ? step : "configuration";
	const [summary, nextAction] = causes[safeCode];
	return { step: safeStep, code: safeCode, summary, nextAction };
}
export function diagnosticFromError(step: GatewayStep, error: unknown): GatewayDiagnostic {
	if (error instanceof GatewayDiagnosticError && Object.hasOwn(causes, error.code)) return gatewayDiagnostic(step, error.code);
	const code = networkErrorCode(error);
	return gatewayDiagnostic(step, code ?? (step === "persistence" ? "persistence-failed" : step === "external-https" ? "external-validation-failed" : "unknown"));
}

/** Inspect codes only, never echo error messages, stderr, URLs, or nested response data. */
export function networkErrorCode(error: unknown): GatewayDiagnosticCode | undefined {
	for (let depth = 0; depth < 3 && error && typeof error === "object"; depth++) {
		const value = error as { code?: unknown; name?: unknown; cause?: unknown };
		if (value.name === "AbortError") return "cancelled";
		if (value.name === "TimeoutError" || ["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"].includes(String(value.code))) return "request-timeout";
		if (["ENOTFOUND", "EAI_AGAIN"].includes(String(value.code))) return "dns-failed";
		if (["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"].includes(String(value.code))) return "tls-failed";
		if (value.code === "ECONNREFUSED") return "connection-refused";
		if (value.code === "EACCES" || value.code === "EPERM") return "permission-denied";
		error = value.cause;
	}
	return undefined;
}
