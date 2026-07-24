import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readInstalledPluginsStore, readInstalledPluginsStoreSync } from "../plugins/installed-store.js";
import { pluginDataPath } from "../state/paths.js";
import type { InstalledPlugin } from "../plugins/types.js";
import { claudeMarketplaceCommandLabel, formatClaudeMarketplaceDescription } from "./display.js";
import { readFrontmatterField, stripFrontmatter } from "./frontmatter.js";

export type CommandRunSpec = {
	pluginSpec: string;
	commandName: string;
	commandArgs: string;
};

function positionalArgs(args: string): string[] {
	return args.trim() ? args.trim().split(/\s+/) : [];
}

function expandCommandPrompt(prompt: string, args: string, plugin: InstalledPlugin): string {
	const positionals = positionalArgs(args);
	return prompt
		.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.cachePath)
		.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginDataPath(plugin.marketplace, plugin.name))
		.replace(/\$ARGUMENTS/g, args)
		.replace(/\$@/g, args)
		.replace(/\$([1-9])\b/g, (_match, index: string) => positionals[Number(index) - 1] ?? "");
}

export function parseCommandRunArgs(args: string): CommandRunSpec | undefined {
	const match = args.trim().match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return {
		pluginSpec: match[1],
		commandName: match[2],
		commandArgs: match[3] ?? "",
	};
}

function resolveInstalledPlugin(plugins: InstalledPlugin[], spec: string): InstalledPlugin {
	const matches = plugins.filter((plugin) => plugin.id === spec || plugin.name === spec);
	if (matches.length === 0) throw new Error(`Installed plugin not found: ${spec}`);
	if (matches.length > 1) throw new Error(`Installed plugin ${spec} is ambiguous. Use plugin@marketplace.`);
	return matches[0];
}

export async function expandInstalledPluginCommand(spec: CommandRunSpec): Promise<{ plugin: InstalledPlugin; prompt: string }> {
	const store = await readInstalledPluginsStore();
	const plugin = resolveInstalledPlugin(store.plugins, spec.pluginSpec);
	if (!plugin.components.commands.includes(spec.commandName)) {
		throw new Error(`Command ${spec.commandName} not found in ${plugin.id}.`);
	}

	const content = stripFrontmatter(await readFile(commandFilePath(plugin, spec.commandName), "utf8"));
	return { plugin, prompt: expandCommandPrompt(content, spec.commandArgs, plugin) };
}

export async function runInstalledPluginCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, spec: CommandRunSpec): Promise<void> {
	const { plugin, prompt } = await expandInstalledPluginCommand(spec);
	if (ctx.isIdle()) {
		pi.sendUserMessage(prompt);
	} else {
		pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		ctx.ui.notify(`Queued ${spec.commandName} from ${plugin.id}.`, "info");
	}
}

export async function pluginRunCommand(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const spec = parseCommandRunArgs(args);
	if (!spec) {
		ctx.ui.notify("Usage: /claude-marketplace-plugin-run <plugin[@marketplace]> <command> [args...]", "warning");
		return;
	}

	try {
		await runInstalledPluginCommand(pi, ctx, spec);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

function safeCommandName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "command";
}

export function generatedPluginCommandName(plugin: InstalledPlugin, commandName: string): string {
	return safeCommandName(`claude-marketplace-${plugin.name}-${commandName}`);
}

function commandFilePath(plugin: InstalledPlugin, commandName: string): string {
	return join(plugin.cachePath, "commands", `${commandName}.md`);
}

export type GeneratedPluginCommandDisplay = {
	value: string;
	label: string;
	description: string;
};

export function generatedPluginCommandDisplay(plugin: InstalledPlugin, commandName: string): GeneratedPluginCommandDisplay {
	let content = "";
	try {
		content = readFileSync(commandFilePath(plugin, commandName), "utf8");
	} catch {
		// Keep the generated command visible even if the cache is temporarily stale.
	}
	const description = readFrontmatterField(content, "description") ?? `Run Claude plugin command ${commandName}.`;
	const argumentHint = readFrontmatterField(content, "argument-hint");
	return {
		value: generatedPluginCommandName(plugin, commandName),
		label: claudeMarketplaceCommandLabel(plugin, commandName),
		description: formatClaudeMarketplaceDescription(plugin, description, argumentHint),
	};
}

export function registerInstalledPluginCommandWrappers(pi: ExtensionAPI): void {
	const used = new Set<string>();
	for (const plugin of readInstalledPluginsStoreSync().plugins) {
		for (const commandName of plugin.components.commands) {
			const display = generatedPluginCommandDisplay(plugin, commandName);
			const name = display.value;
			if (used.has(name)) continue;
			used.add(name);
			pi.registerCommand(name, {
				description: display.description,
				handler: async (args, ctx) => {
					try {
						await runInstalledPluginCommand(pi, ctx, { pluginSpec: plugin.id, commandName, commandArgs: args });
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
				},
			});
		}
	}
}
