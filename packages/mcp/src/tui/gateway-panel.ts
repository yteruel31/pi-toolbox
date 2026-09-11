import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { GatewayReport } from "../commands.js";
import { padPanelLine } from "./panel-frame.js";

export type GatewayPanelResult = { action: "tailscale" | "custom" | "diagnose" | "remove" | "repair" };
export interface GatewayPanelOptions {
	theme: Theme;
	report: GatewayReport;
	onRender: () => void;
	onDone: (result: GatewayPanelResult | null) => void;
}
const actions = [
	{ action: "tailscale", label: "Tailscale", description: "Managed exact route with required user identity" },
	{ action: "custom", label: "Custom", description: "Ask current agent about proxy, domain and access" },
	{ action: "diagnose", label: "Validate external HTTPS", description: "Check the exact capability challenge without saving" },
	{ action: "repair", label: "Ask current agent to repair", description: "Send safe diagnostics; agree before infrastructure changes" },
	{ action: "remove", label: "Deactivate gateway", description: "Revoke local sessions; leave custom proxy unchanged" },
] as const;

/** Gateway section of /mcp, not a separate modal or command. */
export class GatewayPanel implements Component {
	private selected = 0;
	constructor(private readonly options: GatewayPanelOptions) {}
	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) this.selected--;
		else if (matchesKey(data, Key.down)) this.selected++;
		else if (data === "t") return this.options.onDone({ action: "tailscale" });
		else if (data === "c") return this.options.onDone({ action: "custom" });
		else if (data === "d") return this.options.onDone({ action: "diagnose" });
		else if (data === "f") return this.options.onDone({ action: "repair" });
		else if (data === "x") return this.options.onDone({ action: "remove" });
		else if (matchesKey(data, Key.enter)) return this.options.onDone({ action: actions[this.selected]!.action });
		this.selected = Math.max(0, Math.min(this.selected, actions.length - 1));
		this.options.onRender();
	}
	render(width: number, maxRows = 14): string[] {
		const { theme, report } = this.options;
		const lines = [theme.fg(report.mode === "unconfigured" ? "warning" : "text", `Publication: ${report.mode}`)];
		const count = Math.max(1, Math.min(actions.length, Math.floor((maxRows - 2) / 2)));
		const start = Math.min(Math.max(0, this.selected - Math.floor(count / 2)), actions.length - count);
		for (let index = start; index < start + count; index++) {
			const item = actions[index]!;
			const selected = index === this.selected;
			const label = `${selected ? theme.fg("accent", "▸") : " "} ${theme.bold(theme.fg(selected ? "accent" : "text", item.label))}`;
			const description = theme.fg("muted", `  ${item.description}`);
			for (const line of [label, description]) lines.push(selected ? theme.bg("selectedBg", padPanelLine(line, width)) : line);
		}
		if (count < actions.length) lines.push(theme.fg("dim", `${start + 1}-${start + count} of ${actions.length} · ↑↓ more actions`));
		return lines.slice(0, maxRows).map((line) => truncateToWidth(line, Math.max(1, width), ""));
	}
	invalidate(): void {}
}
