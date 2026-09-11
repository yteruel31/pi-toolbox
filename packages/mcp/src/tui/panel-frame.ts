import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Subagents panel conventions, kept package-local so MCP remains independently installable. */
export function padPanelLine(value: string, width: number): string {
	const bounded = truncateToWidth(value, Math.max(1, width), "");
	return bounded + " ".repeat(Math.max(0, width - visibleWidth(bounded)));
}
export function panelFrame(theme: Theme, title: string, content: string[], footer: string[], width: number, maxRows: number): string[] {
	width = Math.max(1, width);
	if (width < 4 || maxRows < 6) return [...content, ...footer].slice(0, maxRows).map((line) => truncateToWidth(line, width, ""));
	const inner = width - 2;
	const heading = ` ${theme.bold(theme.fg("accent", title))} `;
	const row = (line: string) => `${theme.fg("borderMuted", "│")}${padPanelLine(line, inner)}${theme.fg("borderMuted", "│")}`;
	return [
		`${theme.fg("borderAccent", "╭─")}${heading}${theme.fg("borderAccent", "─".repeat(Math.max(0, width - visibleWidth(heading) - 3)) + "╮")}`,
		...content.slice(0, Math.max(0, maxRows - footer.length - 3)).map(row),
		theme.fg("borderMuted", `├${"─".repeat(inner)}┤`),
		...footer.map(row),
		theme.fg("borderAccent", `╰${"─".repeat(inner)}╯`),
	].map((line) => truncateToWidth(line, width, ""));
}
