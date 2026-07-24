import { spawn } from "node:child_process";
import type { ExtensionContext, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { readMarketplaceEnv } from "../mcp/env.js";
import { readInstalledPluginsStore } from "../plugins/installed-store.js";
import type { InstalledPlugin } from "../plugins/types.js";
import { replaceUserConfigPlaceholders, resolvePluginUserConfig, type ResolvedPluginUserConfig } from "../plugins/user-config.js";
import { pluginDataPath } from "../state/paths.js";
import { preparePluginHooks } from "./config-loader.js";
import { readHookBridgeStore } from "./hook-store.js";
import type { HookDecision, PreparedHook } from "./types.js";

const DEFAULT_HOOK_TIMEOUT_MS = 30_000;

function claudeToolName(toolName: string): string {
	const map: Record<string, string> = {
		bash: "Bash",
		read: "Read",
		edit: "Edit",
		write: "Write",
		grep: "Grep",
		find: "Glob",
		ls: "LS",
		web_search: "WebSearch",
		fetch_content: "WebFetch",
	};
	return map[toolName] ?? toolName;
}

function matcherMatches(matcher: string | undefined, toolName: string): boolean {
	const trimmed = matcher?.trim();
	if (!trimmed || trimmed === "*") return true;
	const parts = trimmed.split("|").map((part) => part.trim()).filter(Boolean);
	if (parts.length > 1) return parts.includes(toolName);
	if (/^[A-Za-z0-9_.:-]+$/.test(trimmed)) return trimmed === toolName;
	try {
		return new RegExp(trimmed).test(toolName);
	} catch {
		return false;
	}
}

function replacePlaceholders(text: string, plugin: InstalledPlugin, userConfig: ResolvedPluginUserConfig): string {
	const withPluginPaths = text.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.cachePath).replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginDataPath(plugin.marketplace, plugin.name));
	return replaceUserConfigPlaceholders(withPluginPaths, userConfig);
}

function extractJsonObject(output: string): unknown | undefined {
	const trimmed = output.trim();
	if (!trimmed) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		const start = trimmed.indexOf("{");
		const end = trimmed.lastIndexOf("}");
		if (start === -1 || end <= start) return undefined;
		try {
			return JSON.parse(trimmed.slice(start, end + 1)) as unknown;
		} catch {
			return undefined;
		}
	}
}

function decisionFromOutput(output: unknown): { decision?: HookDecision; reason?: string; updatedInput?: Record<string, unknown> } {
	if (!output || typeof output !== "object" || Array.isArray(output)) return {};
	const object = output as Record<string, unknown>;
	const specific = object.hookSpecificOutput && typeof object.hookSpecificOutput === "object" && !Array.isArray(object.hookSpecificOutput) ? (object.hookSpecificOutput as Record<string, unknown>) : undefined;
	const decision = (specific?.permissionDecision ?? object.decision) as unknown;
	const reason = (specific?.permissionDecisionReason ?? object.reason) as unknown;
	const updatedInput = specific?.updatedInput ?? object.updatedInput;
	return {
		decision: decision === "allow" || decision === "deny" || decision === "ask" || decision === "defer" ? decision : undefined,
		reason: typeof reason === "string" ? reason : undefined,
		updatedInput: updatedInput && typeof updatedInput === "object" && !Array.isArray(updatedInput) ? (updatedInput as Record<string, unknown>) : undefined,
	};
}

function runShellCommand(command: string, input: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
	return new Promise((resolve) => {
		const child = spawn(command, { cwd: options.cwd, env: options.env, shell: true, stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
		}, options.timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ stdout, stderr: stderr || error.message, code: 1, timedOut });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, code, timedOut });
		});
		child.stdin.end(input);
	});
}

async function executeCommandHook(hook: PreparedHook, event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	if (hook.handler.type !== "command" || !hook.handler.command) return undefined;
	const marketplaceEnv = await readMarketplaceEnv(hook.plugin.marketplace);
	const userConfig = await resolvePluginUserConfig(hook.plugin, marketplaceEnv);
	const dataPath = pluginDataPath(hook.plugin.marketplace, hook.plugin.name);
	const env = {
		...process.env,
		PERMISSION_GUARD_LOG_DIR: `${dataPath}/logs`,
		PERMISSION_GUARD_CACHE_DIR: `${dataPath}/cache`,
		...marketplaceEnv,
		...userConfig.env,
		CLAUDE_PLUGIN_ROOT: hook.plugin.cachePath,
		CLAUDE_PLUGIN_DATA: dataPath,
	};
	const toolName = claudeToolName(event.toolName);
	const payload = {
		hook_event_name: "PreToolUse",
		session_id: undefined,
		transcript_path: undefined,
		cwd: ctx.cwd,
		tool_name: toolName,
		pi_tool_name: event.toolName,
		tool_input: event.input,
		tool_use_id: event.toolCallId,
	};
	const timeoutSeconds = typeof hook.handler.timeout === "number" ? hook.handler.timeout : undefined;
	const result = await runShellCommand(replacePlaceholders(hook.handler.command, hook.plugin, userConfig), `${JSON.stringify(payload)}\n`, {
		cwd: ctx.cwd,
		env,
		timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : DEFAULT_HOOK_TIMEOUT_MS,
		signal: ctx.signal,
	});

	if (result.timedOut) return { block: true, reason: `${hook.plugin.id} PreToolUse hook timed out.` };
	const parsed = extractJsonObject(result.stdout);
	const decision = decisionFromOutput(parsed);
	if (decision.updatedInput) {
		for (const key of Object.keys(event.input)) delete (event.input as Record<string, unknown>)[key];
		Object.assign(event.input, decision.updatedInput);
	}
	if (decision.decision === "allow") return undefined;
	if (decision.decision === "deny" || decision.decision === "defer") return { block: true, reason: decision.reason || `${hook.plugin.id} blocked ${toolName}.` };
	if (decision.decision === "ask") {
		const reason = decision.reason || `${hook.plugin.id} asks before running ${toolName}.`;
		if (!ctx.hasUI) return { block: true, reason };
		const allowed = await ctx.ui.confirm("Claude marketplace permission hook", [`${hook.plugin.id} asks whether to allow ${toolName}.`, "", reason].join("\n"));
		return allowed ? undefined : { block: true, reason: `User denied ${toolName}: ${reason}` };
	}
	if (result.code === 2) return { block: true, reason: result.stderr.trim() || `${hook.plugin.id} blocked ${toolName}.` };
	if (result.code && result.code !== 0) ctx.ui.notify(`${hook.plugin.id} hook failed and was ignored: ${result.stderr.trim() || `exit ${result.code}`}`, "warning");
	return undefined;
}

async function enabledPreparedHooksForPreToolUse(): Promise<PreparedHook[]> {
	const store = await readHookBridgeStore();
	if (store.hooks.length === 0) return [];
	const enabled = new Set(store.hooks.filter((hook) => hook.event === "PreToolUse" && hook.type === "command").map((hook) => hook.id));
	if (enabled.size === 0) return [];
	const installed = await readInstalledPluginsStore();
	const prepared = (await Promise.all(installed.plugins.map((plugin) => preparePluginHooks(plugin)))).flat();
	return prepared.filter((hook) => enabled.has(hook.id));
}

export async function runPreToolUseHooks(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
	const toolName = claudeToolName(event.toolName);
	for (const hook of await enabledPreparedHooksForPreToolUse()) {
		if (!matcherMatches(hook.matcher, toolName)) continue;
		const result = await executeCommandHook(hook, event, ctx);
		if (result?.block) return result;
	}
	return undefined;
}
