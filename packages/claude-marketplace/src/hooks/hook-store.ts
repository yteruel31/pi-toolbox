import type { InstalledPlugin } from "../plugins/types.js";
import { hookBridgeStorePath } from "../state/paths.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import { preparePluginHooks } from "./config-loader.js";
import type { PreparedHook, HookBridgeStore, SyncedHook } from "./types.js";

const EMPTY_STORE: HookBridgeStore = { version: 1, hooks: [] };

function normalizeHookBridgeStore(store: HookBridgeStore): HookBridgeStore {
	return { version: 1, hooks: Array.isArray(store.hooks) ? store.hooks : [] };
}

export async function readHookBridgeStore(): Promise<HookBridgeStore> {
	return normalizeHookBridgeStore(await readJsonFile<HookBridgeStore>(hookBridgeStorePath(), EMPTY_STORE));
}

export async function writeHookBridgeStore(store: HookBridgeStore): Promise<void> {
	await writeJsonFile(hookBridgeStorePath(), normalizeHookBridgeStore(store));
}

export function syncedHookFromPrepared(hook: PreparedHook): SyncedHook {
	return {
		id: hook.id,
		marketplace: hook.plugin.marketplace,
		plugin: hook.plugin.name,
		pluginVersion: hook.plugin.version,
		event: hook.event,
		matcher: hook.matcher,
		type: hook.handler.type,
		command: hook.handler.command,
		timeout: hook.handler.timeout,
		enabledAt: new Date().toISOString(),
	};
}

export async function enableHooks(hooks: PreparedHook[]): Promise<SyncedHook[]> {
	const store = await readHookBridgeStore();
	const ids = new Set(hooks.map((hook) => hook.id));
	const synced = hooks.map(syncedHookFromPrepared);
	await writeHookBridgeStore({ version: 1, hooks: [...store.hooks.filter((hook) => !ids.has(hook.id)), ...synced].sort((a, b) => a.id.localeCompare(b.id)) });
	return synced;
}

export async function disableHooks(ids: string[]): Promise<SyncedHook[]> {
	const store = await readHookBridgeStore();
	const idSet = new Set(ids);
	const removed = store.hooks.filter((hook) => idSet.has(hook.id));
	await writeHookBridgeStore({ version: 1, hooks: store.hooks.filter((hook) => !idSet.has(hook.id)) });
	return removed;
}

export async function enabledHookIds(): Promise<Set<string>> {
	return new Set((await readHookBridgeStore()).hooks.map((hook) => hook.id));
}

export function isSupportedAutoHook(hook: PreparedHook): boolean {
	return hook.event === "PreToolUse" && hook.handler.type === "command";
}

export async function enableSupportedHooksForPlugins(plugins: InstalledPlugin[]): Promise<SyncedHook[]> {
	const hooks = (await Promise.all(plugins.map((plugin) => preparePluginHooks(plugin)))).flat().filter(isSupportedAutoHook);
	if (hooks.length === 0) return [];
	return enableHooks(hooks);
}

export async function removeEnabledHooksForPlugins(plugins: { marketplace: string; name: string }[]): Promise<SyncedHook[]> {
	const store = await readHookBridgeStore();
	const removed = store.hooks.filter((hook) => plugins.some((plugin) => plugin.marketplace === hook.marketplace && plugin.name === hook.plugin));
	if (removed.length === 0) return [];
	await disableHooks(removed.map((hook) => hook.id));
	return removed;
}
