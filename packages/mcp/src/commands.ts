import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadMcpConfig, parseGatewaySettings, type McpConfig, type McpGatewaySettings, type McpUiSettings } from "./config.js";
import { writeMcpGatewaySettings } from "./config-writer.js";
import { GatewayClient, GatewayIncompatibleError } from "./gateway/client.js";
import { TailscaleAdapter, TailscaleMutationError, type RouteMutationResult } from "./tailscale.js";
import { GatewayPanel, type GatewayPanelResult } from "./tui/gateway-panel.js";

export interface GatewayOperations {
	ensure(): Promise<void>;
	hello(): Promise<void>;
	shutdown(): Promise<void>;
	verify(): Promise<void>;
}

export interface GatewayTailscale {
	status(settings: McpUiSettings): Promise<{ state: "absent" | "matching" | "conflicting"; target: string }>;
	hostname(): Promise<string | undefined>;
	setup(settings: McpUiSettings): Promise<RouteMutationResult>;
	remove(settings: McpUiSettings): Promise<RouteMutationResult>;
}

export interface GatewayCommandDependencies {
	tailscale?: GatewayTailscale;
	clientFactory?: (gateway: McpGatewaySettings, settings: McpUiSettings) => GatewayOperations;
	configLoader?: () => McpConfig;
	writer?: (gateway: McpGatewaySettings | undefined) => Promise<unknown>;
	quiesce?: () => Promise<void>;
	maintenance?: <T>(operation: () => Promise<T>) => Promise<T>;
}

function effectiveSettings(config: McpConfig, gateway: McpGatewaySettings): McpUiSettings {
	const settings = { ...config.settings.ui };
	if (gateway.mode === "tailscale") return { ...settings, requireTailscaleIdentity: true };
	const pathname = new URL(gateway.externalUrl).pathname;
	return { ...settings, basePath: pathname || "/", requireTailscaleIdentity: false };
}

function productionClient(gateway: McpGatewaySettings, settings: McpUiSettings, tailscale: GatewayTailscale): GatewayOperations {
	if (gateway.mode === "custom") {
		return new GatewayClient({ settings, externalUrlResolver: async () => gateway.externalUrl, listenAddress: gateway.listenAddress });
	}
	return new GatewayClient({ settings, hostnameResolver: async () => {
		if (settings.hostname !== "auto") return settings.hostname;
		const hostname = await tailscale.hostname();
		if (!hostname) throw new Error("Tailscale hostname unavailable");
		return hostname;
	} });
}

async function panel(context: ExtensionCommandContext, config: McpConfig): Promise<GatewayPanelResult | null> {
	return context.ui.custom<GatewayPanelResult | null>((tui, theme, _keybindings, done) => new GatewayPanel({
		theme,
		gateway: config.settings.gateway,
		onRender: () => tui.requestRender(),
		onDone: done,
	}), { overlay: true, overlayOptions: { width: "75%", minWidth: 58, maxHeight: "75%", anchor: "center", margin: 1 } });
}

async function candidateFromAction(action: GatewayPanelResult, context: ExtensionCommandContext, gatewayPort: number, current?: McpGatewaySettings): Promise<McpGatewaySettings | undefined> {
	if (action.action === "tailscale") return { mode: "tailscale" };
	if (action.action !== "custom") return undefined;
	const externalUrl = await context.ui.input("External gateway URL", current?.mode === "custom" ? current.externalUrl : "https://mcp.example.com");
	if (externalUrl === undefined) return undefined;
	const listenAddress = await context.ui.input("Gateway listen address", current?.mode === "custom" ? current.listenAddress : "127.0.0.1");
	if (listenAddress === undefined) return undefined;
	const candidate = parseGatewaySettings({ mode: "custom", externalUrl, listenAddress });
	if (!candidate || candidate.mode !== "custom") {
		context.ui.notify("Custom gateway settings are invalid. Use an HTTPS URL without credentials, query, or fragment and an IP listen address.", "error");
		return undefined;
	}
	const address = candidate.listenAddress.includes(":") ? `[${candidate.listenAddress}]` : candidate.listenAddress;
	const ready = await context.ui.confirm(
		"Validate custom MCP gateway?",
		`Configure your reverse proxy to preserve the external URL path when forwarding to http://${address}:${gatewayPort}. Non-loopback listeners expose cleartext capability endpoints on that interface.`,
	);
	return ready ? candidate : undefined;
}

function mutationChanged(error: unknown, operation: "setup" | "remove"): boolean {
	return error instanceof TailscaleMutationError && error.operation === operation && error.changed;
}

function sameGatewayState(left: McpGatewaySettings | undefined, right: McpGatewaySettings | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	const normalizedLeft = parseGatewaySettings(left);
	const normalizedRight = parseGatewaySettings(right);
	if (!normalizedLeft || !normalizedRight || normalizedLeft.mode !== normalizedRight.mode) return false;
	return normalizedLeft.mode === "tailscale" || normalizedRight.mode === "custom" &&
		normalizedLeft.externalUrl === normalizedRight.externalUrl && normalizedLeft.listenAddress === normalizedRight.listenAddress;
}

function hasGatewayPostcondition(load: () => McpConfig, gateway: McpGatewaySettings | undefined): boolean {
	try { return sameGatewayState(load().settings.gateway, gateway); }
	catch { return false; }
}

async function maintenance<T>(dependencies: GatewayCommandDependencies, operation: () => Promise<T>): Promise<T> {
	return dependencies.maintenance ? dependencies.maintenance(operation) : operation();
}

export async function openGatewayPanel(context: ExtensionCommandContext, dependencies: GatewayCommandDependencies = {}): Promise<void> {
	if (context.mode !== "tui") {
		context.ui.notify("/mcp-gateway requires the interactive Pi TUI.", "warning");
		return;
	}
	const load = dependencies.configLoader ?? loadMcpConfig;
	const tailscale = dependencies.tailscale ?? new TailscaleAdapter();
	const write = dependencies.writer ?? ((gateway) => writeMcpGatewaySettings(gateway));
	const initialConfig = load();
	const action = await panel(context, initialConfig);
	if (!action) return;

	if (action.action === "diagnose") {
		try {
			await maintenance(dependencies, async () => {
				const config = load();
				const gateway = config.settings.gateway;
				if (!gateway) throw new Error("unconfigured");
				const settings = effectiveSettings(config, gateway);
				const client = dependencies.clientFactory?.(gateway, settings) ?? productionClient(gateway, settings, tailscale);
				if (gateway.mode === "tailscale" && (await tailscale.status(settings)).state !== "matching") throw new Error("route unavailable");
				await client.verify();
				context.ui.notify(`MCP gateway ${gateway.mode} validation succeeded.`, "info");
			});
		} catch {
			const mode = load().settings.gateway?.mode;
			context.ui.notify(mode
				? `MCP gateway ${mode} validation failed. Check the configured route, HTTPS certificate, and proxy target.`
				: "MCP gateway is not configured.", mode ? "error" : "warning");
		}
		return;
	}

	if (action.action === "remove") {
		const initialGateway = initialConfig.settings.gateway;
		if (!initialGateway) {
			context.ui.notify("MCP gateway is already unconfigured.", "info");
			return;
		}
		if (!await context.ui.confirm("Deactivate MCP gateway?", initialGateway.mode === "custom"
			? "Pi will revoke sessions and clear its configuration. The external reverse proxy will not be changed."
			: "Pi will revoke sessions, remove only its exact Tailscale Serve route, and clear its configuration.")) return;
		try {
			await maintenance(dependencies, async () => {
				const config = load();
				const gateway = config.settings.gateway;
				if (!gateway) {
					context.ui.notify("MCP gateway is already unconfigured.", "info");
					return;
				}
				let quiesceStarted = false;
				let removedTailscaleRoute = false;
				let persistedRemoval = false;
				let writeAttempted = false;
				const notifyRemoved = (): void => context.ui.notify(gateway.mode === "custom" ? "MCP gateway deactivated. Remove the external proxy separately if it is no longer needed." : "MCP gateway deactivated.", "info");
				try {
					quiesceStarted = true;
					await dependencies.quiesce?.();
					const settings = effectiveSettings(config, gateway);
					const client = dependencies.clientFactory?.(gateway, settings) ?? productionClient(gateway, settings, tailscale);
					await client.shutdown();
					if (gateway.mode === "tailscale") {
						try { removedTailscaleRoute = (await tailscale.remove(settings)).changed; }
						catch (error) { removedTailscaleRoute = mutationChanged(error, "remove"); throw error; }
					}
					writeAttempted = true;
					await write(undefined);
					persistedRemoval = true;
					notifyRemoved();
				} catch {
					if (writeAttempted && hasGatewayPostcondition(load, undefined)) {
						persistedRemoval = true;
						notifyRemoved();
					} else {
						if (!persistedRemoval && removedTailscaleRoute && gateway.mode === "tailscale") await tailscale.setup(effectiveSettings(config, gateway)).catch(() => undefined);
						context.ui.notify("MCP gateway could not be deactivated; existing configuration was preserved when possible.", "error");
					}
				} finally {
					if (quiesceStarted) await context.reload();
				}
			});
		} catch {
			context.ui.notify("MCP gateway maintenance was cancelled because the Pi runtime changed.", "warning");
		}
		return;
	}

	const candidate = await candidateFromAction(action, context, initialConfig.settings.ui.gatewayPort, initialConfig.settings.gateway);
	if (!candidate) return;
	try {
		await maintenance(dependencies, async () => {
			const config = load();
			const settings = effectiveSettings(config, candidate);
			const client = dependencies.clientFactory?.(candidate, settings) ?? productionClient(candidate, settings, tailscale);
			let quiesceStarted = false;
			let candidateStarted = false;
			let changedTailscaleRoute = false;
			let persisted = false;
			let writeAttempted = false;
			const changedInfrastructure = config.settings.gateway !== undefined && !sameGatewayState(config.settings.gateway, candidate);
			const notifyConfigured = (): void => context.ui.notify(`MCP gateway ${candidate.mode} configured and externally validated.${changedInfrastructure ? " Previous external infrastructure was left unchanged; deactivate it separately if needed." : ""}`, changedInfrastructure ? "warning" : "info");
			try {
				quiesceStarted = true;
				await dependencies.quiesce?.();
				await client.shutdown();
				await client.ensure();
				candidateStarted = true;
				if (candidate.mode === "tailscale") {
					try { changedTailscaleRoute = (await tailscale.setup(settings)).changed; }
					catch (error) { changedTailscaleRoute = mutationChanged(error, "setup"); throw error; }
				}
				await client.verify();
				writeAttempted = true;
				await write(candidate);
				persisted = true;
				notifyConfigured();
			} catch (error) {
				if (writeAttempted && hasGatewayPostcondition(load, candidate)) {
					persisted = true;
					notifyConfigured();
				} else {
					if (!persisted && candidateStarted) await client.shutdown().catch(() => undefined);
					if (!persisted && candidate.mode === "tailscale" && changedTailscaleRoute) await tailscale.remove(settings).catch(() => undefined);
					const incompatible = error instanceof GatewayIncompatibleError;
					context.ui.notify(incompatible
						? "MCP gateway uses an incompatible resident daemon; wait for it to stop or restart Pi before retrying."
						: "MCP gateway validation failed; configuration was not saved. Check HTTPS, routing, active gateway sessions, and the local proxy target.", "error");
				}
			} finally {
				if (quiesceStarted) await context.reload();
			}
		});
	} catch {
		context.ui.notify("MCP gateway maintenance was cancelled because the Pi runtime changed.", "warning");
	}
}

export function registerGatewayCommand(pi: ExtensionAPI, dependencies: GatewayCommandDependencies = {}): void {
	pi.registerCommand("mcp-gateway", {
		description: "Configure and diagnose MCP gateway publication",
		getArgumentCompletions: () => null,
		handler: async (_argumentsText, context) => openGatewayPanel(context, dependencies),
	});
}
