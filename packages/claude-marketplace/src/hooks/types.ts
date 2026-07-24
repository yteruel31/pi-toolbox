import type { InstalledPlugin } from "../plugins/types.js";

export type ClaudeHookType = "command" | "http" | "mcp_tool" | "prompt" | "agent";

export type ClaudeHookHandler = {
	type: ClaudeHookType;
	command?: string;
	timeout?: number;
	[key: string]: unknown;
};

export type ClaudeHookMatcherGroup = {
	matcher?: string;
	hooks?: ClaudeHookHandler[];
	[key: string]: unknown;
};

export type ClaudeHooksConfig = {
	hooks: Record<string, ClaudeHookMatcherGroup[]>;
};

export type PreparedHook = {
	id: string;
	plugin: InstalledPlugin;
	event: string;
	matcher?: string;
	handler: ClaudeHookHandler;
};

export type SyncedHook = {
	id: string;
	marketplace: string;
	plugin: string;
	pluginVersion: string;
	event: string;
	matcher?: string;
	type: ClaudeHookType;
	command?: string;
	timeout?: number;
	enabledAt: string;
};

export type HookBridgeStore = {
	version: 1;
	hooks: SyncedHook[];
};

export type HookDecision = "allow" | "deny" | "ask" | "defer";
