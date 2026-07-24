import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { generatedPluginCommandDisplay } from "../components/commands.js";
import { claudeMarketplaceSkillLabel, formatClaudeMarketplaceDescription } from "../components/display.js";
import { readFrontmatterField } from "../components/frontmatter.js";
import { generatedSkillName, listPluginSkillSourcesSync } from "../components/skills.js";
import { readInstalledPluginsStoreSync } from "../plugins/installed-store.js";
import type { InstalledPlugin } from "../plugins/types.js";

export type AutocompleteDisplay = {
	value: string;
	label: string;
	description: string;
};

let autocompleteDisplayRegistered = false;

function generatedSkillDisplay(plugin: InstalledPlugin, sourceName: string, sourcePath: string): AutocompleteDisplay {
	let content = "";
	try {
		content = readFileSync(sourcePath, "utf8");
	} catch {
		// Keep the generated skill visible even if the cache is temporarily stale.
	}
	const description = readFrontmatterField(content, "description") ?? `Claude marketplace skill from ${plugin.id}.`;
	const argumentHint = readFrontmatterField(content, "argument-hint");
	return {
		value: `skill:${generatedSkillName(plugin, sourceName)}`,
		label: claudeMarketplaceSkillLabel(sourceName),
		description: formatClaudeMarketplaceDescription(plugin, description, argumentHint),
	};
}

export function buildClaudeMarketplaceAutocompleteDisplays(): Map<string, AutocompleteDisplay> {
	const displays = new Map<string, AutocompleteDisplay>();
	for (const plugin of readInstalledPluginsStoreSync().plugins) {
		for (const commandName of plugin.components.commands) {
			const display = generatedPluginCommandDisplay(plugin, commandName);
			displays.set(display.value, display);
		}
		for (const source of listPluginSkillSourcesSync(plugin)) {
			const display = generatedSkillDisplay(plugin, source.name, source.path);
			displays.set(display.value, display);
		}
	}
	return displays;
}

function slashCommandPrefix(lines: string[], cursorLine: number, cursorCol: number): string | undefined {
	const currentLine = lines[cursorLine] || "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	if (!textBeforeCursor.startsWith("/") || textBeforeCursor.includes(" ")) return undefined;
	return textBeforeCursor;
}

function itemFromDisplay(display: AutocompleteDisplay): AutocompleteItem {
	return { value: display.value, label: display.label, description: display.description };
}

function fuzzyScore(query: string, text: string): number | undefined {
	const normalizedQuery = query.toLowerCase();
	const normalizedText = text.toLowerCase();
	if (!normalizedQuery) return 0;
	if (normalizedText.startsWith(normalizedQuery)) return normalizedQuery.length;
	if (normalizedText.includes(normalizedQuery)) return normalizedQuery.length - 1;

	let queryIndex = 0;
	let score = 0;
	for (let textIndex = 0; textIndex < normalizedText.length && queryIndex < normalizedQuery.length; textIndex += 1) {
		if (normalizedText[textIndex] !== normalizedQuery[queryIndex]) continue;
		queryIndex += 1;
		score += 1;
	}
	return queryIndex === normalizedQuery.length ? score - 2 : undefined;
}

function fuzzyDisplayFilter(displays: AutocompleteDisplay[], query: string): AutocompleteDisplay[] {
	return displays
		.map((display, index) => ({ display, index, score: fuzzyScore(query, `${display.label} ${display.value} ${display.description}`) }))
		.filter((entry): entry is { display: AutocompleteDisplay; index: number; score: number } => entry.score !== undefined)
		.sort((a, b) => b.score - a.score || a.index - b.index)
		.map((entry) => entry.display);
}

class ClaudeMarketplaceAutocompleteProvider implements AutocompleteProvider {
	constructor(
		private readonly current: AutocompleteProvider,
		private readonly displays: Map<string, AutocompleteDisplay>,
	) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const suggestions = await this.current.getSuggestions(lines, cursorLine, cursorCol, options);
		if (suggestions) {
			return { ...suggestions, items: suggestions.items.map((item) => this.transformItem(item)) };
		}

		const prefix = slashCommandPrefix(lines, cursorLine, cursorCol);
		if (!prefix) return null;
		const query = prefix.slice(1);
		const matches = fuzzyDisplayFilter([...this.displays.values()], query);
		if (matches.length === 0) return null;
		return { prefix, items: matches.map(itemFromDisplay) };
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string): { lines: string[]; cursorLine: number; cursorCol: number } {
		return this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
	}

	private transformItem(item: AutocompleteItem): AutocompleteItem {
		const display = this.displays.get(item.value);
		return display ? { ...item, label: display.label, description: display.description } : item;
	}
}

export function registerClaudeMarketplaceAutocompleteDisplay(ctx: ExtensionContext): void {
	if (!ctx.hasUI || autocompleteDisplayRegistered) return;
	const displays = buildClaudeMarketplaceAutocompleteDisplays();
	if (displays.size === 0) return;
	ctx.ui.addAutocompleteProvider((current) => new ClaudeMarketplaceAutocompleteProvider(current, displays));
	autocompleteDisplayRegistered = true;
}
