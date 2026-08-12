import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { McpGatewaySettings } from "../config.js";

export type GatewayPanelResult =
	| { action: "tailscale" }
	| { action: "custom" }
	| { action: "diagnose" }
	| { action: "remove" };

export interface GatewayPanelOptions {
	theme: Theme;
	gateway?: McpGatewaySettings;
	onRender: () => void;
	onDone: (result: GatewayPanelResult | null) => void;
}

function terminalText(value: string, maximum = 2_048): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, maximum);
}

export class GatewayPanel implements Component {
	private selected = 0;
	private closed = false;
	private readonly rows = ["tailscale", "custom", "diagnose", "remove"] as const;

	constructor(private readonly options: GatewayPanelOptions) {}

	private finish(result: GatewayPanelResult | null): void {
		if (this.closed) return;
		this.closed = true;
		this.options.onDone(result);
	}

	handleInput(data: string): void {
		if (this.closed) return;
		if (matchesKey(data, Key.escape)) return this.finish(null);
		if (matchesKey(data, Key.up)) this.selected--;
		else if (matchesKey(data, Key.down)) this.selected++;
		else if (data === "t") return this.finish({ action: "tailscale" });
		else if (data === "c") return this.finish({ action: "custom" });
		else if (data === "d") return this.finish({ action: "diagnose" });
		else if (data === "x") return this.finish({ action: "remove" });
		else if (matchesKey(data, Key.enter)) return this.finish({ action: this.rows[this.selected]! });
		this.selected = Math.max(0, Math.min(this.selected, this.rows.length - 1));
		this.options.onRender();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const usable = Math.max(1, width);
		const line = (value: string): string => truncateToWidth(value, usable);
		const gateway = this.options.gateway;
		const mode = gateway?.mode ?? "unconfigured";
		const detail = gateway?.mode === "custom" ? ` · ${terminalText(gateway.externalUrl)} · listen ${terminalText(gateway.listenAddress)}` : "";
		const labels: Record<typeof this.rows[number], string> = {
			tailscale: "Configure managed Tailscale",
			custom: "Configure custom HTTPS reverse proxy",
			diagnose: "Diagnose and validate current mode",
			remove: "Remove / deactivate gateway",
		};
		const output = [
			line(theme.fg("accent", theme.bold("MCP Gateway"))),
			line(theme.fg(gateway ? "success" : "warning", `Current: ${mode}${detail}`)),
			line(theme.fg("borderMuted", "─".repeat(usable))),
		];
		for (let index = 0; index < this.rows.length; index++) {
			const row = this.rows[index]!;
			const content = line(`${index === this.selected ? "›" : " "} ${labels[row]}`);
			output.push(index === this.selected ? theme.bg("selectedBg", content + " ".repeat(Math.max(0, usable - visibleWidth(content)))) : content);
		}
		output.push(line(theme.fg("borderMuted", "─".repeat(usable))));
		output.push(line(theme.fg("dim", "↑↓ navigate  enter select  t tailscale  c custom  d diagnose  x remove  esc close")));
		return output;
	}

	invalidate(): void { /* rendering uses the injected live theme */ }
}
