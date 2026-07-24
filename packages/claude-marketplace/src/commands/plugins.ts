import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { generatePluginAgents, generatedAgentName, listPluginAgentSources } from "../components/agents.js";
import { listIndexedPlugins, resolvePluginSpecs } from "../plugins/plugin-index.js";
import { readInstalledPluginsStore, removeInstalledPlugins } from "../plugins/installed-store.js";
import { installIndexedPlugins } from "../plugins/installer.js";
import { formatExternalPluginSource } from "../plugins/source.js";
import { ensureMarketplaceEnvTemplateForPlugins, resolveEnvReference } from "../mcp/env.js";
import { preparePluginHooks } from "../hooks/config-loader.js";
import { disableHooks, enableHooks, enabledHookIds, readHookBridgeStore } from "../hooks/hook-store.js";
import { listInstalledPluginsBySpecs, resolveOneInstalledPlugin } from "../mcp/installed.js";
import { readMcpBridgeStore } from "../mcp/mcp-store.js";
import { preparePluginMcpServers, syncedServersById } from "../mcp/status.js";
import { preparePluginsForMcpSync, syncPreparedMcpServers, unsyncMcpServers } from "../mcp/sync.js";
import type { IndexedPlugin, InstalledPlugin, PluginComponentSummary } from "../plugins/types.js";
import { collectPluginUserConfigSpecs } from "../plugins/user-config.js";
import { marketplaceEnvPath } from "../state/paths.js";
import { multiSelect, type MultiSelectItem } from "../ui/multi-select.js";

function splitArgs(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function componentCount(components: PluginComponentSummary | undefined): string {
	if (!components) return "components unavailable";
	return `commands:${components.commands.length} skills:${components.skills.length} agents:${components.agents.length} hooks:${components.hooks.length} mcp:${components.mcpServers.length}`;
}

function formatIndexedPlugin(plugin: IndexedPlugin, installedIds: Set<string>): string {
	const status = installedIds.has(plugin.id) ? "installed" : "available";
	const category = plugin.entry.category ? ` ${plugin.entry.category}` : "";
	return `${plugin.id} ${plugin.version}${category} — ${status} — ${componentCount(plugin.components)}`;
}

function formatInstalledPlugin(plugin: InstalledPlugin): string {
	return `${plugin.id} ${plugin.version} ${plugin.sourceType} — ${componentCount(plugin.components)}`;
}

function formatComponents(components: PluginComponentSummary | undefined): string[] {
	if (!components) return ["Components unavailable for external plugin sources."];
	const sections: Array<[string, string[]]> = [
		["Commands", components.commands],
		["Skills", components.skills],
		["Agents", components.agents],
		["Hooks", components.hooks],
		["MCP servers", components.mcpServers],
	];
	return sections.flatMap(([title, values]) => [title, ...(values.length ? values.map((value) => `- ${value}`) : ["- none"]), ""]);
}

async function resolveOnePlugin(spec: string): Promise<IndexedPlugin> {
	const resolved = await resolvePluginSpecs([spec]);
	return resolved[0];
}

export async function listPluginsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const mode = splitArgs(args).find((arg) => arg.startsWith("--")) ?? "--all";
	const plugins = await listIndexedPlugins();
	const installed = await readInstalledPluginsStore();
	const installedIds = new Set(installed.plugins.map((plugin) => plugin.id));

	let lines: string[];
	if (mode === "--installed") {
		lines = installed.plugins.map(formatInstalledPlugin);
	} else {
		const filtered = mode === "--available" ? plugins.filter((plugin) => !installedIds.has(plugin.id)) : plugins;
		lines = filtered.map((plugin) => formatIndexedPlugin(plugin, installedIds));
	}

	if (lines.length === 0) {
		ctx.ui.notify("No plugins found for the selected filter.", "info");
		return;
	}

	ctx.ui.notify(["Claude marketplace plugins", "", ...lines].join("\n"), "info");
}

export async function pluginInfoCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-info <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOnePlugin(spec);
		const lines = [
			`${plugin.entry.name} @ ${plugin.marketplace.name}`,
			`version: ${plugin.version}`,
			`source type: ${plugin.sourceType}`,
			plugin.externalSource ? `source: ${formatExternalPluginSource(plugin.externalSource)}` : undefined,
			plugin.entry.category ? `category: ${plugin.entry.category}` : undefined,
			plugin.entry.description ? `description: ${plugin.entry.description}` : undefined,
			plugin.pluginPath ? `path: ${plugin.pluginPath}` : undefined,
			plugin.pluginManifestPath ? `manifest: ${plugin.pluginManifestPath}` : undefined,
			"",
			"Components:",
			`- ${componentCount(plugin.components)}`,
		].filter((line): line is string => line !== undefined);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginComponentsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-components <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const installed = await readInstalledPluginsStore();
		const installedMatches = installed.plugins.filter((plugin) => plugin.id === spec || plugin.name === spec);
		if (installedMatches.length > 1) throw new Error(`Installed plugin ${spec} is ambiguous. Use plugin@marketplace.`);
		if (installedMatches.length === 1) {
			const plugin = installedMatches[0];
			ctx.ui.notify([`${plugin.id}`, "", ...formatComponents(plugin.components)].join("\n"), "info");
			return;
		}

		const plugin = await resolveOnePlugin(spec);
		ctx.ui.notify([`${plugin.id}`, "", ...formatComponents(plugin.components)].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginAgentsCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-agents <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		const sources = await listPluginAgentSources(plugin);
		await generatePluginAgents(plugin);
		const lines = sources.length
			? sources.flatMap((source) => [`- ${source.name}: ${generatedAgentName(plugin, source.name)}`, `  run: /run ${generatedAgentName(plugin, source.name)} "<task>"`])
			: ["- none"];
		ctx.ui.notify([`${plugin.id} agents`, "", ...lines].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginAgentRunCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const match = args.trim().match(/^(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/);
	if (!match) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-agent-run <plugin[@marketplace]> <agent> <task>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(match[1]);
		const sources = await listPluginAgentSources(plugin);
		const source = sources.find((candidate) => candidate.name === match[2] || generatedAgentName(plugin, candidate.name) === match[2]);
		if (!source) throw new Error(`Agent ${match[2]} not found in ${plugin.id}.`);
		await generatePluginAgents(plugin);
		const task = match[3]?.trim();
		if (!task) {
			ctx.ui.notify("Provide a task for the agent to run.", "warning");
			return;
		}
		const command = `/run ${generatedAgentName(plugin, source.name)} ${JSON.stringify(task)}`;
		if (ctx.isIdle()) pi.sendUserMessage(command);
		else {
			pi.sendUserMessage(command, { deliverAs: "followUp" });
			ctx.ui.notify(`Queued ${source.name} from ${plugin.id}.`, "info");
		}
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginHooksCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-hooks <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const installed = await readInstalledPluginsStore();
		const installedPlugin = installed.plugins.find((plugin) => plugin.id === spec || plugin.name === spec);
		if (installedPlugin) {
			const enabled = await enabledHookIds();
			const hooks = await preparePluginHooks(installedPlugin);
			const lines = hooks.length
				? hooks.map((hook) => `- ${hook.event}${hook.matcher ? ` matcher=${hook.matcher}` : ""} ${hook.handler.type}${hook.handler.command ? `: ${hook.handler.command}` : ""} — ${enabled.has(hook.id) ? "enabled" : "disabled"}${hook.event === "PreToolUse" && hook.handler.type === "command" ? "" : " (unsupported by MVP)"}`)
				: ["- none"];
			ctx.ui.notify([`${installedPlugin.id} hooks`, "", ...lines].join("\n"), "info");
			return;
		}

		const plugin = await resolveOnePlugin(spec);
		const hooks = plugin.components?.hooks ?? [];
		ctx.ui.notify([`${plugin.id} hooks`, "", ...(hooks.length ? hooks.map((hook) => `- ${hook}: detected, install plugin to inspect/enable`) : ["- none"])].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginHooksEnableCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-hooks-enable <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		const hooks = (await preparePluginHooks(plugin)).filter((hook) => hook.event === "PreToolUse" && hook.handler.type === "command");
		if (hooks.length === 0) {
			ctx.ui.notify(`${plugin.id} has no supported PreToolUse command hooks.`, "info");
			return;
		}

		const confirmed = await ctx.ui.confirm(
			"Enable Claude marketplace hooks?",
			[
				`Enable ${hooks.length} PreToolUse command hook(s) for ${plugin.id}?`,
				"",
				...hooks.map((hook) => `- ${hook.handler.command}`),
				"",
				"Hooks execute plugin code before Pi tools run and can block tool calls. Only enable hooks from marketplaces you trust.",
				plugin.name === "permission-guard" ? `Env is read from ${marketplaceEnvPath(plugin.marketplace)}. Set PERMISSION_GUARD_LLM_ENABLED=false for regex-only mode, or provide a provider API key for LLM judging.` : undefined,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n"),
		);
		if (!confirmed) return;

		const synced = await enableHooks(hooks);
		ctx.ui.notify([`Enabled ${synced.length} hook(s) for ${plugin.id}:`, ...synced.map((hook) => `- ${hook.event}: ${hook.command}`)].join("\n"), "warning");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginHooksDisableCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-hooks-disable <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		const store = await readHookBridgeStore();
		const ids = store.hooks.filter((hook) => hook.marketplace === plugin.marketplace && hook.plugin === plugin.name).map((hook) => hook.id);
		if (ids.length === 0) {
			ctx.ui.notify(`${plugin.id} has no enabled hooks.`, "info");
			return;
		}
		const removed = await disableHooks(ids);
		ctx.ui.notify([`Disabled ${removed.length} hook(s) for ${plugin.id}:`, ...removed.map((hook) => `- ${hook.event}: ${hook.command}`)].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

function formatEnvStatus(name: string, missing: boolean, defaultValue?: string, source?: string): string {
	if (!missing) return `${name}: ok${source ? ` from ${source}` : ""}`;
	if (defaultValue !== undefined) return `${name}: default ${defaultValue}`;
	return `${name}: missing`;
}

async function formatMcpServerLines(plugin: InstalledPlugin): Promise<string[]> {
	const synced = await syncedServersById();
	const servers = await preparePluginMcpServers(plugin);
	if (servers.length === 0) return ["- none"];

	return servers.flatMap((server) => {
		const syncedServer = synced.get(server.id);
		return [
			`- ${server.originalName}: ${syncedServer ? `synced as ${syncedServer.piServerName}` : "detected, not synced"}`,
			`  pi server: ${server.piServerName}`,
			server.config.command ? `  command: ${server.config.command}` : undefined,
			server.config.url ? `  url: ${server.config.url}` : undefined,
			server.diagnostics.localCode ? `  source: local code${server.diagnostics.serverDirectory ? ` (${server.diagnostics.serverDirectory})` : ""}` : "  source: remote/package",
			server.diagnostics.env.length ? `  env: ${server.diagnostics.env.map((env) => formatEnvStatus(env.name, env.missing, env.defaultValue, env.source)).join(", ")}` : undefined,
			server.diagnostics.riskNotes.length ? `  risks: ${server.diagnostics.riskNotes.join("; ")}` : undefined,
		].filter((line): line is string => line !== undefined);
	});
}

export async function pluginMcpCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-mcp <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		ctx.ui.notify([`${plugin.id} MCP servers`, "", ...(await formatMcpServerLines(plugin))].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginMcpDoctorCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-mcp-doctor <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		const hasAdapter = pi.getAllTools().some((tool) => tool.name === "mcp");
		const servers = await preparePluginMcpServers(plugin);
		const lines = [`${plugin.id} MCP doctor`, "", `pi-mcp-adapter: ${hasAdapter ? "installed" : "missing (pi install npm:pi-mcp-adapter)"}`, `marketplace env: ${marketplaceEnvPath(plugin.marketplace)}`, ""];
		for (const server of servers) {
			lines.push(server.originalName, `  pi server: ${server.piServerName}`, `  source: ${server.diagnostics.localCode ? "local plugin code" : "remote/package"}`);
			if (server.diagnostics.serverDirectory) lines.push(`  directory: ${server.diagnostics.serverDirectory}`);
			if (server.config.command) lines.push(`  command: ${server.config.command}`);
			if (server.config.args?.length) lines.push(`  args: ${server.config.args.join(" ")}`);
			if (server.config.url) lines.push(`  url: ${server.config.url}`);
			lines.push(
				`  runtimes: ${server.diagnostics.runtimes.length ? server.diagnostics.runtimes.map((runtime) => `${runtime.command}:${runtime.available ? "ok" : "missing"}`).join(", ") : "none detected"}`,
				`  env: ${server.diagnostics.env.length ? server.diagnostics.env.map((env) => formatEnvStatus(env.name, env.missing, env.defaultValue, env.source)).join(", ") : "none"}`, 
				`  files: ${server.diagnostics.files.length ? server.diagnostics.files.join(", ") : "none detected"}`,
				`  risks: ${server.diagnostics.riskNotes.length ? server.diagnostics.riskNotes.join("; ") : "none detected"}`,
				"",
			);
		}
		if (servers.length === 0) lines.push("No MCP servers detected.");
		ctx.ui.notify(lines.join("\n"), hasAdapter ? "info" : "warning");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginEnvCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-env <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		const servers = await preparePluginMcpServers(plugin);
		const mcpEnvLines = servers.flatMap((server) =>
			server.diagnostics.env
				.filter((env) => !env.name.startsWith("CLAUDE_PLUGIN_OPTION_"))
				.map((env) => `- ${env.name}: ${formatEnvStatus(env.name, env.missing, env.defaultValue, env.source).replace(`${env.name}: `, "")} (server: ${server.originalName})`),
		);
		const userConfigSpecs = await collectPluginUserConfigSpecs(plugin);
		const userConfigEnvLines = await Promise.all(
			userConfigSpecs.map(async (spec) => {
				const env = await resolveEnvReference(plugin.marketplace, { name: spec.envName, defaultValue: spec.defaultValue });
				return `- ${env.name}: ${formatEnvStatus(env.name, env.missing, env.defaultValue, env.source).replace(`${env.name}: `, "")} (userConfig: ${spec.key}${spec.sensitive ? ", sensitive" : ""})`;
			}),
		);
		const envLines = [...mcpEnvLines, ...userConfigEnvLines];
		ctx.ui.notify([`${plugin.id} marketplace env`, `file: ${marketplaceEnvPath(plugin.marketplace)}`, "", ...(envLines.length ? envLines : ["No MCP environment variables or userConfig options detected."])].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginEnvInitCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = splitArgs(args)[0];
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-env-init <plugin[@marketplace]>", "warning");
		return;
	}

	try {
		const plugin = await resolveOneInstalledPlugin(spec);
		const [result] = await ensureMarketplaceEnvTemplateForPlugins([plugin]);
		if (!result || result.required.length === 0) {
			ctx.ui.notify(`${plugin.id} does not require marketplace env entries.`, "info");
			return;
		}
		ctx.ui.notify([`Marketplace env file: ${result.path}`, result.added.length ? `Added placeholder(s): ${result.added.join(", ")}` : "All required placeholders already exist.", "", "Fill missing values, then run /claude-marketplace-plugin-mcp-sync again."].join("\n"), result.added.length ? "warning" : "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginMcpSyncCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		if (!pi.getAllTools().some((tool) => tool.name === "mcp")) {
			ctx.ui.notify("pi-mcp-adapter is required for MCP sync. Install it with: pi install npm:pi-mcp-adapter", "warning");
			return;
		}
		const specs = splitArgs(args);
		if (specs.length === 0) {
			ctx.ui.notify("Usage: /claude-marketplace-plugin-mcp-sync <plugin[@marketplace] ...>", "warning");
			return;
		}
		const plugins = await listInstalledPluginsBySpecs(specs);
		const prepared = await preparePluginsForMcpSync(plugins);
		if (prepared.length === 0) {
			ctx.ui.notify("No MCP servers detected for selected installed plugin(s).", "info");
			return;
		}

		const missingEnv = prepared.flatMap((server) => server.diagnostics.env.filter((env) => env.missing).map((env) => `${server.id}: ${env.name}`));
		if (missingEnv.length > 0) {
			const envFiles = [...new Set(plugins.map((plugin) => marketplaceEnvPath(plugin.marketplace)))];
			ctx.ui.notify(["Cannot sync MCP server(s): required environment variables are missing.", "", ...missingEnv.map((env) => `- ${env}`), "", "Fill the marketplace env file(s), then retry sync:", ...envFiles.map((path) => `- ${path}`)].join("\n"), "warning");
			return;
		}

		const confirmed = await ctx.ui.confirm(
			"Sync Claude marketplace MCP servers?",
			[
				`Sync ${prepared.length} MCP server(s) into Pi MCP adapter config?`,
				"",
				...prepared.map((server) => `- ${server.id} -> ${server.piServerName}${server.diagnostics.riskNotes.length ? ` (${server.diagnostics.riskNotes.join("; ")})` : ""}`),
				"",
				"Servers are configured lazy/proxy-only by default. Sync writes config only; it does not start server code.",
			].join("\n"),
		);
		if (!confirmed) return;

		const result = await syncPreparedMcpServers(prepared);
		ctx.ui.notify([`Synced ${result.servers.length} MCP server(s) to ${result.adapterConfigPath}:`, ...result.servers.map((server) => `- ${server.piServerName}`), "", "Run /reload or /mcp reconnect to let pi-mcp-adapter pick up changes."].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginMcpUnsyncCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const specs = splitArgs(args);
		let ids: string[];
		if (specs.length > 0) {
			const plugins = await listInstalledPluginsBySpecs(specs);
			const prepared = await preparePluginsForMcpSync(plugins);
			ids = prepared.map((server) => server.id);
		} else {
			ids = (await readMcpBridgeStore()).servers.map((server) => server.id);
		}
		if (ids.length === 0) {
			ctx.ui.notify("No synced Claude marketplace MCP servers found.", "info");
			return;
		}

		const confirmed = await ctx.ui.confirm("Unsync Claude marketplace MCP servers?", `Remove ${ids.length} managed MCP server(s) from Pi MCP adapter config?`);
		if (!confirmed) return;

		const result = await unsyncMcpServers(ids);
		ctx.ui.notify([`Unsynced ${result.servers.length} MCP server(s) from ${result.adapterConfigPath}:`, ...result.servers.map((server) => `- ${server.piServerName}`), "", "Run /reload or /mcp reconnect to let pi-mcp-adapter pick up changes."].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

function pluginSelectItems(plugins: IndexedPlugin[]): MultiSelectItem[] {
	return plugins.map((plugin) => ({
		id: plugin.id,
		label: `${plugin.entry.name} @ ${plugin.marketplace.name}`,
		description: `${plugin.version} · ${plugin.sourceType}${plugin.entry.category ? ` · ${plugin.entry.category}` : ""}`,
	}));
}

function installableIndexedPlugins(plugins: IndexedPlugin[]): IndexedPlugin[] {
	return plugins.filter((plugin) => plugin.sourceType === "local" || plugin.sourceType === "github");
}

function installedSelectItems(plugins: InstalledPlugin[]): MultiSelectItem[] {
	return plugins.map((plugin) => ({
		id: plugin.id,
		label: `${plugin.name} @ ${plugin.marketplace}`,
		description: plugin.version,
	}));
}

export async function pluginInstallCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const installed = await readInstalledPluginsStore();
		const installedIds = new Set(installed.plugins.map((plugin) => plugin.id));
		const argSpecs = splitArgs(args);
		let plugins: IndexedPlugin[];

		if (argSpecs.length > 0) {
			plugins = await resolvePluginSpecs(argSpecs);
		} else {
			const candidates = installableIndexedPlugins(await listIndexedPlugins()).filter((plugin) => !installedIds.has(plugin.id));
			if (candidates.length === 0) {
				ctx.ui.notify("No available installable plugins found.", "info");
				return;
			}
			const selected = await multiSelect(ctx, "Install Claude marketplace plugins", pluginSelectItems(candidates));
			if (!selected || selected.length === 0) {
				ctx.ui.notify("No plugins selected.", "info");
				return;
			}
			const selectedIds = new Set(selected);
			plugins = candidates.filter((plugin) => selectedIds.has(plugin.id));
		}

		const unsupported = plugins.filter((plugin) => plugin.sourceType === "external");
		if (unsupported.length > 0) {
			ctx.ui.notify(["Unsupported external plugin source(s):", ...unsupported.map((plugin) => `- ${plugin.id}`), "", "Supported external source type for now: GitHub source objects with repo/ref/path."].join("\n"), "warning");
			return;
		}

		const alreadyInstalled = plugins.filter((plugin) => installedIds.has(plugin.id));
		const toInstall = plugins.filter((plugin) => !installedIds.has(plugin.id));
		if (toInstall.length === 0) {
			ctx.ui.notify(`Nothing to install.${alreadyInstalled.length ? " Selected plugin(s) are already installed." : ""}`, "info");
			return;
		}

		const githubPlugins = toInstall.filter((plugin) => plugin.sourceType === "github");
		if (githubPlugins.length > 0) {
			const confirmed = await ctx.ui.confirm(
				"Install external Claude marketplace plugin?",
				[
					`Download and install ${githubPlugins.length} GitHub plugin source(s)?`,
					"",
					...githubPlugins.map((plugin) => `- ${plugin.id}: ${formatExternalPluginSource(plugin.externalSource) ?? "github source"}`),
					"",
					"External plugin sources are downloaded into the local cache and may later expose commands, skills, agents, hooks, or MCP servers. Only install sources you trust.",
				].join("\n"),
			);
			if (!confirmed) return;
		}

		const result = await installIndexedPlugins(toInstall);
		const hookStore = await readHookBridgeStore();
		const autoEnabledHooks = hookStore.hooks.filter((hook) => result.some((plugin) => plugin.marketplace === hook.marketplace && plugin.name === hook.plugin));
		const hookLines = autoEnabledHooks.length > 0 ? ["", `Auto-enabled supported hook(s): ${autoEnabledHooks.length}`, ...autoEnabledHooks.map((hook) => `- ${hook.plugin}@${hook.marketplace} ${hook.event}: ${hook.command}`)] : [];
		const envInit = await ensureMarketplaceEnvTemplateForPlugins(result);
		const envLines = envInit.filter((entry) => entry.required.length > 0).flatMap((entry) => ["", `Marketplace env file: ${entry.path}`, entry.added.length ? `Added missing placeholder(s): ${entry.added.join(", ")}` : "Required env placeholders already exist."]);
		ctx.ui.notify([`Installed ${result.length} plugin(s):`, ...result.map((plugin) => `- ${plugin.id}`), ...hookLines, ...envLines, "", "Run /reload to expose generated slash commands, skills, and agents."].join("\n"), hookLines.length || envLines.length ? "warning" : "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function pluginUninstallCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	try {
		const store = await readInstalledPluginsStore();
		const argSpecs = splitArgs(args);
		let ids: string[];

		if (argSpecs.length > 0) {
			ids = argSpecs.map((spec) => {
				const matches = store.plugins.filter((plugin) => plugin.id === spec || plugin.name === spec);
				if (matches.length === 0) throw new Error(`Installed plugin not found: ${spec}`);
				if (matches.length > 1) throw new Error(`Installed plugin ${spec} is ambiguous. Use plugin@marketplace.`);
				return matches[0].id;
			});
		} else {
			if (store.plugins.length === 0) {
				ctx.ui.notify("No installed plugins to uninstall.", "info");
				return;
			}
			const selected = await multiSelect(ctx, "Uninstall Claude marketplace plugins", installedSelectItems(store.plugins));
			if (!selected || selected.length === 0) {
				ctx.ui.notify("No plugins selected.", "info");
				return;
			}
			ids = selected;
		}

		const confirmed = await ctx.ui.confirm(
			"Uninstall Claude marketplace plugins?",
			`Uninstall ${ids.length} plugin(s)?\n\nGenerated resources, cache copies, and synced MCP config entries will be removed. Durable plugin data will be kept.`,
		);
		if (!confirmed) return;

		const selectedPlugins = store.plugins.filter((plugin) => ids.includes(plugin.id));
		const bridgeStore = await readMcpBridgeStore();
		const mcpIds = bridgeStore.servers
			.filter((server) => selectedPlugins.some((plugin) => plugin.marketplace === server.marketplace && plugin.name === server.plugin))
			.map((server) => server.id);
		if (mcpIds.length > 0) await unsyncMcpServers(mcpIds);

		const removed = await removeInstalledPlugins(ids);
		ctx.ui.notify([`Uninstalled ${removed.length} plugin(s):`, ...removed.map((plugin) => `- ${plugin.id}`)].join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}
