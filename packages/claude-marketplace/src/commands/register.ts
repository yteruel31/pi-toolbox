import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pluginRunCommand, registerInstalledPluginCommandWrappers } from "../components/commands.js";
import { missingRequiredPackages, checkPiPackages } from "../prerequisites/check-pi-packages.js";
import { showDoctor } from "./doctor.js";
import { addMarketplaceCommand, listMarketplacesCommand, refreshMarketplacesCommand, removeMarketplaceCommand } from "./marketplaces.js";
import {
	listPluginsCommand,
	pluginAgentRunCommand,
	pluginAgentsCommand,
	pluginComponentsCommand,
	pluginEnvCommand,
	pluginEnvInitCommand,
	pluginHooksCommand,
	pluginHooksDisableCommand,
	pluginHooksEnableCommand,
	pluginInfoCommand,
	pluginInstallCommand,
	pluginMcpCommand,
	pluginMcpDoctorCommand,
	pluginMcpSyncCommand,
	pluginMcpUnsyncCommand,
	pluginUninstallCommand,
} from "./plugins.js";

function missingPrerequisiteMessage(pi: ExtensionAPI): string | undefined {
	const missing = missingRequiredPackages(checkPiPackages(pi));
	if (missing.length === 0) return undefined;

	return [
		"Claude Marketplace prerequisites are missing.",
		"",
		...missing.map((status) => `Install ${status.name}: ${status.installCommand}`),
		"",
		"Then restart Pi or run /reload.",
	].join("\n");
}

function registerGuardedCommand(
	pi: ExtensionAPI,
	name: string,
	description: string,
	handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const message = missingPrerequisiteMessage(pi);
			if (message) {
				ctx.ui.notify(message, "warning");
				return;
			}
			await handler(args, ctx);
		},
	});
}

export function registerClaudeMarketplaceCommands(pi: ExtensionAPI): void {
	pi.registerCommand("claude-marketplace-doctor", {
		description: "Check Claude Marketplace prerequisites and optional integrations",
		handler: (_args, ctx) => showDoctor(pi, ctx),
	});

	registerGuardedCommand(pi, "claude-marketplace-list", "List configured Claude marketplaces", listMarketplacesCommand);
	registerGuardedCommand(pi, "claude-marketplace-add", "Add a Claude marketplace source", addMarketplaceCommand);
	registerGuardedCommand(pi, "claude-marketplace-refresh", "Refresh one or all Claude marketplaces", refreshMarketplacesCommand);
	registerGuardedCommand(pi, "claude-marketplace-remove", "Remove a Claude marketplace source", removeMarketplaceCommand);

	registerGuardedCommand(pi, "claude-marketplace-plugin-list", "List available or installed Claude marketplace plugins", listPluginsCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-info", "Show information about a Claude marketplace plugin", pluginInfoCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-install", "Install one or more Claude marketplace plugins", pluginInstallCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-uninstall", "Uninstall one or more Claude marketplace plugins", pluginUninstallCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-run", "Run an installed Claude marketplace plugin command", (args, ctx) => pluginRunCommand(pi, args, ctx));
	registerGuardedCommand(pi, "claude-marketplace-plugin-components", "List a plugin's bridged commands, skills, agents, hooks, and MCP servers", pluginComponentsCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-agents", "List a plugin's generated Pi subagents", pluginAgentsCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-agent-run", "Run a generated plugin subagent", (args, ctx) => pluginAgentRunCommand(pi, args, ctx));
	registerGuardedCommand(pi, "claude-marketplace-plugin-hooks", "List a plugin's hooks and their activation status", pluginHooksCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-hooks-enable", "Enable supported installed plugin hooks", pluginHooksEnableCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-hooks-disable", "Disable installed plugin hooks", pluginHooksDisableCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-env", "Show a plugin's required MCP environment variables", pluginEnvCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-env-init", "Create marketplace .env placeholders for a plugin", pluginEnvInitCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-mcp", "Show a plugin's MCP bridge status", pluginMcpCommand);
	registerGuardedCommand(pi, "claude-marketplace-plugin-mcp-doctor", "Diagnose a plugin's MCP servers and prerequisites", (args, ctx) => pluginMcpDoctorCommand(pi, args, ctx));
	registerGuardedCommand(pi, "claude-marketplace-plugin-mcp-sync", "Sync installed plugin MCP servers into pi-mcp-adapter config", (args, ctx) => pluginMcpSyncCommand(pi, args, ctx));
	registerGuardedCommand(pi, "claude-marketplace-plugin-mcp-unsync", "Remove managed plugin MCP servers from pi-mcp-adapter config", pluginMcpUnsyncCommand);

	registerInstalledPluginCommandWrappers(pi);
}
