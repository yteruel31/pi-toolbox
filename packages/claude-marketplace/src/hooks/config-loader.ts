import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledPlugin } from "../plugins/types.js";
import type { ClaudeHookHandler, ClaudeHookMatcherGroup, ClaudeHooksConfig, PreparedHook } from "./types.js";

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function normalizeHookHandler(value: unknown): ClaudeHookHandler | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const object = value as Record<string, unknown>;
	if (typeof object.type !== "string") return undefined;
	return object as ClaudeHookHandler;
}

function normalizeHookGroup(value: unknown): ClaudeHookMatcherGroup | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const object = value as Record<string, unknown>;
	const hooks = Array.isArray(object.hooks) ? object.hooks.map(normalizeHookHandler).filter((hook): hook is ClaudeHookHandler => hook !== undefined) : [];
	return { ...object, matcher: typeof object.matcher === "string" ? object.matcher : undefined, hooks };
}

function normalizeHooksConfig(value: unknown): ClaudeHooksConfig {
	const root = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const hooksValue = root.hooks && typeof root.hooks === "object" && !Array.isArray(root.hooks) ? (root.hooks as Record<string, unknown>) : root;
	const hooks: Record<string, ClaudeHookMatcherGroup[]> = {};
	for (const [event, groupsValue] of Object.entries(hooksValue)) {
		if (!Array.isArray(groupsValue)) continue;
		const groups = groupsValue.map(normalizeHookGroup).filter((group): group is ClaudeHookMatcherGroup => group !== undefined && (group.hooks?.length ?? 0) > 0);
		if (groups.length > 0) hooks[event] = groups;
	}
	return { hooks };
}

export async function loadPluginHooksConfig(plugin: InstalledPlugin): Promise<ClaudeHooksConfig> {
	const hooksFile = await readJsonObject(join(plugin.cachePath, "hooks", "hooks.json"));
	if (hooksFile) return normalizeHooksConfig(hooksFile);

	const pluginManifest = await readJsonObject(join(plugin.cachePath, ".claude-plugin", "plugin.json"));
	return normalizeHooksConfig(pluginManifest?.hooks);
}

function hookId(plugin: InstalledPlugin, event: string, groupIndex: number, hookIndex: number, handler: ClaudeHookHandler): string {
	const suffix = handler.type === "command" && handler.command ? handler.command.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-|-$/g, "") : `${handler.type}-${hookIndex}`;
	return `${plugin.marketplace}:${plugin.name}:${event}:${groupIndex}:${hookIndex}:${suffix}`;
}

export async function preparePluginHooks(plugin: InstalledPlugin): Promise<PreparedHook[]> {
	const config = await loadPluginHooksConfig(plugin);
	const prepared: PreparedHook[] = [];
	for (const [event, groups] of Object.entries(config.hooks)) {
		groups.forEach((group, groupIndex) => {
			(group.hooks ?? []).forEach((handler, hookIndex) => {
				prepared.push({ id: hookId(plugin, event, groupIndex, hookIndex, handler), plugin, event, matcher: group.matcher, handler });
			});
		});
	}
	return prepared.sort((a, b) => a.id.localeCompare(b.id));
}
