import { homedir } from "node:os";
import { join } from "node:path";

export function piAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function claudeMarketplaceStateDir(): string {
	return join(piAgentDir(), "claude-marketplace");
}

export function marketplacesStorePath(): string {
	return join(claudeMarketplaceStateDir(), "marketplaces.json");
}

export function installedPluginsStorePath(): string {
	return join(claudeMarketplaceStateDir(), "installed.json");
}

export function pluginCachePath(marketplace: string, plugin: string, version: string): string {
	return join(claudeMarketplaceStateDir(), "cache", marketplace, plugin, version);
}

export function generatedPluginPath(marketplace: string, plugin: string): string {
	return join(claudeMarketplaceStateDir(), "generated", marketplace, plugin);
}

export function generatedPluginSkillsPath(marketplace: string, plugin: string): string {
	return join(generatedPluginPath(marketplace, plugin), "skills");
}

export function generatedPluginAgentsPath(marketplace: string, plugin: string): string {
	return join(piAgentDir(), "agents", "claude-marketplace", marketplace, plugin);
}

export function pluginDataPath(marketplace: string, plugin: string): string {
	return join(claudeMarketplaceStateDir(), "data", marketplace, plugin);
}

export function marketplaceEnvPath(marketplace: string): string {
	return join(claudeMarketplaceStateDir(), "env", `${marketplace}.env`);
}

export function hookBridgeStorePath(): string {
	return join(claudeMarketplaceStateDir(), "hooks.json");
}

export function mcpBridgeStorePath(): string {
	return join(claudeMarketplaceStateDir(), "mcp.json");
}

export function piMcpAdapterConfigPath(): string {
	return join(piAgentDir(), "mcp.json");
}
