import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadMcpConfig, type McpConfig, type McpUiSettings } from "./config.js";
import { GatewayClient, GatewayIncompatibleError } from "./gateway/client.js";
import { TailscaleAdapter } from "./tailscale.js";

export interface GatewayProbe {
	ensure(): Promise<void>;
	hello(): Promise<void>;
}

export interface GatewayTailscale {
	status(settings: McpUiSettings): Promise<{ state: "absent" | "matching" | "conflicting"; target: string }>;
	hostname(): Promise<string | undefined>;
	setup(settings: McpUiSettings): Promise<unknown>;
	remove(settings: McpUiSettings): Promise<unknown>;
}

export function registerGatewayCommand(
	pi: ExtensionAPI,
	tailscale: GatewayTailscale = new TailscaleAdapter(),
	clientFactory?: (hostname: string) => GatewayProbe,
	configLoader: () => McpConfig = loadMcpConfig,
): void {
	pi.registerCommand("mcp-gateway", {
		description: "Configure or diagnose the private MCP Apps gateway",
		handler: async (argumentsText, context) => {
			const [action, ...flags] = argumentsText.trim().split(/\s+/);
			try {
				const settings = configLoader().settings.ui;
				const resolveHostname = async (): Promise<string> => {
					const hostname = settings.hostname === "auto" ? await tailscale.hostname() : settings.hostname;
					if (!hostname) throw new Error("Tailscale hostname unavailable");
					return hostname;
				};
				const makeClient = (hostname: string): GatewayProbe => clientFactory?.(hostname) ?? new GatewayClient({ settings, hostnameResolver: async () => hostname });

				if (action === "setup") {
					const hostname = await resolveHostname();
					await makeClient(hostname).ensure();
					await tailscale.setup(settings);
					context.ui.notify("MCP gateway Serve route is configured.", "info");
				} else if (action === "remove") {
					let confirmed = flags.includes("--yes");
					if (!confirmed) confirmed = await context.ui.confirm("Remove MCP gateway route?", "Only the exact configured route will be removed.");
					if (!confirmed) {
						context.ui.notify("Removal cancelled.", "info");
						return;
					}
					await tailscale.remove(settings);
					context.ui.notify("MCP gateway Serve route removed.", "info");
				} else if (action === "doctor") {
					const route = await tailscale.status(settings);
					const hostname = await resolveHostname();
					let gateway: "compatible" | "incompatible" | "unreachable" = "unreachable";
					try {
						await makeClient(hostname).hello();
						gateway = "compatible";
					} catch (error) {
						if (error instanceof GatewayIncompatibleError) gateway = "incompatible";
					}
					const level = route.state === "conflicting" || gateway === "incompatible" ? "warning" : "info";
					context.ui.notify(`Gateway: ${gateway}; Tailscale hostname: ${hostname}; route: ${route.state}`, level);
				} else {
					context.ui.notify("Usage: /mcp-gateway setup|doctor|remove [--yes]", "warning");
				}
			} catch {
				const operation = action === "setup" || action === "doctor" || action === "remove" ? action : "command";
				const guidance = operation === "doctor" ? "Check Tailscale and the gateway configuration." : "Run /mcp-gateway doctor.";
				context.ui.notify(`MCP gateway ${operation} failed. ${guidance}`, "error");
			}
		},
	});
}
