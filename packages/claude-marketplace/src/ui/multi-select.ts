import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

export type MultiSelectItem = {
	id: string;
	label: string;
	description?: string;
};

function matchesQuery(item: MultiSelectItem, query: string): boolean {
	if (!query) return true;
	const haystack = `${item.label} ${item.description ?? ""}`.toLowerCase();
	return query
		.toLowerCase()
		.split(/\s+/)
		.filter(Boolean)
		.every((part) => haystack.includes(part));
}

function fit(text: string, width: number): string {
	if (width <= 0) return "";
	return visibleWidth(text) > width ? truncateToWidth(text, width) : text;
}

export async function multiSelect(
	ctx: ExtensionCommandContext,
	title: string,
	items: MultiSelectItem[],
): Promise<string[] | undefined> {
	if (items.length === 0) return [];

	return ctx.ui.custom<string[] | undefined>((tui, theme, _keybindings, done) => {
		let cursor = 0;
		let query = "";
		const selected = new Set<string>();

		function filteredItems(): MultiSelectItem[] {
			return items.filter((item) => matchesQuery(item, query));
		}

		function move(delta: number): void {
			const filtered = filteredItems();
			if (filtered.length === 0) {
				cursor = 0;
				return;
			}
			cursor = Math.max(0, Math.min(filtered.length - 1, cursor + delta));
		}

		function toggleCurrent(): void {
			const item = filteredItems()[cursor];
			if (!item) return;
			if (selected.has(item.id)) selected.delete(item.id);
			else selected.add(item.id);
		}

		const component: Component & { handleInput(data: string): void } = {
			invalidate() {},
			render(width: number) {
				const filtered = filteredItems();
				const maxRows = Math.min(12, Math.max(1, filtered.length));
				const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), Math.max(0, filtered.length - maxRows)));
				const visible = filtered.slice(start, start + maxRows);
				const lines = [
					theme.fg("accent", theme.bold(title)),
					`Search: ${query || theme.fg("dim", "type to filter")}`,
					`Selected: ${selected.size}`,
					"",
				];

				if (filtered.length === 0) {
					lines.push(theme.fg("warning", "No matches."));
				} else {
					for (const [offset, item] of visible.entries()) {
						const index = start + offset;
						const active = index === cursor;
						const mark = selected.has(item.id) ? "[x]" : "[ ]";
						const prefix = active ? "›" : " ";
						const description = item.description ? theme.fg("muted", ` — ${item.description}`) : "";
						const row = fit(`${prefix} ${mark} ${item.label}${description}`, width);
						lines.push(active ? theme.fg("accent", row) : row);
					}
				}

				lines.push("", theme.fg("dim", "↑↓ navigate • space toggle • enter confirm • esc cancel • backspace edit filter"));
				return lines;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
					done([...selected]);
					return;
				}
				if (matchesKey(data, Key.up)) move(-1);
				else if (matchesKey(data, Key.down)) move(1);
				else if (matchesKey(data, Key.space)) toggleCurrent();
				else if (matchesKey(data, Key.backspace) || matchesKey(data, Key.delete)) {
					query = query.slice(0, -1);
					cursor = 0;
				} else {
					const printable = data.length === 1 ? data : decodeKittyPrintable(data);
					if (printable && printable.length === 1 && !/\s/.test(printable)) {
						query += printable;
						cursor = 0;
					}
				}
				tui.requestRender();
			},
		};

		return component;
	}, { overlay: true });
}
