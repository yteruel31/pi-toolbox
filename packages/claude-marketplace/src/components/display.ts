import type { InstalledPlugin } from "../plugins/types.js";

function normalizeDisplayPart(value: string): string {
	return value.trim().replace(/[\\/]+/g, ":").replace(/\s+/g, "-");
}

export function claudeMarketplaceCommandLabel(plugin: InstalledPlugin, commandName: string): string {
	return `claude-marketplace:${normalizeDisplayPart(plugin.name)}:${normalizeDisplayPart(commandName)}`;
}

export function claudeMarketplaceSkillLabel(skillName: string): string {
	return `skill:${normalizeDisplayPart(skillName)}`;
}

export function formatClaudeMarketplaceDescription(plugin: InstalledPlugin, description?: string, argumentHint?: string): string {
	const source = `(${plugin.marketplace}:${plugin.name})`;
	const hint = argumentHint?.trim();
	const text = description?.trim();
	if (hint && text) return `${source}: ${hint} — ${text}`;
	if (hint) return `${source}: ${hint}`;
	if (text) return `${source}: ${text}`;
	return source;
}
