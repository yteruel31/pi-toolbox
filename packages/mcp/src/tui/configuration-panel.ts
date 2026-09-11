import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { GatewayReport } from "../commands.js";
import type { McpServerControls } from "../config.js";
import type { McpStatusServer } from "../mcp/status.js";
import { GatewayPanel, type GatewayPanelResult } from "./gateway-panel.js";
import { McpPanel, type McpPanelOptions } from "./mcp-panel.js";
import { panelFrame } from "./panel-frame.js";

export type ConfigurationPanelResult = { updates: Record<string, McpServerControls> } | GatewayPanelResult | { action: "auth-complete"; server: string };
export type ConfigurationSection = "Servers" | "Gateway" | "Diagnostics";
interface Options extends Omit<McpPanelOptions, "onDone"> {
	theme: Theme;
	report: GatewayReport;
	section?: ConfigurationSection;
	maxRows: () => number;
	onValidate: () => Promise<GatewayReport>;
	onDone: (result: ConfigurationPanelResult | null) => void;
	onDispose?: () => void;
}
const sections: ConfigurationSection[] = ["Servers", "Gateway", "Diagnostics"];

export class ConfigurationPanel implements Component {
	private readonly servers: McpPanel;
	private readonly gateway: GatewayPanel;
	private section: ConfigurationSection;
	private report: GatewayReport;
	private notice?: string;
	private busy = false;
	private closed = false;
	private scroll = 0;
	private tooSmall = false;

	constructor(private readonly options: Options) {
		this.section = options.section ?? "Servers";
		this.report = options.report;
		this.servers = new McpPanel({ ...options,
			onOpenGateway: () => { this.section = "Gateway"; this.options.onRender(); },
			onDone: (result) => {
			if (result && "openGateway" in result) { this.section = "Gateway"; this.options.onRender(); }
			else this.finish(result);
		} });
		this.gateway = new GatewayPanel({ ...options, onDone: (result) => { if (result) this.gatewayAction(result); } });
	}
	updateServers(servers: McpStatusServer[]): void { if (!this.closed) this.servers.updateServers(servers); }
	private finish(result: ConfigurationPanelResult | null): void {
		if (this.closed || this.busy) return;
		this.dispose();
		this.options.onDone(result);
	}
	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.servers.dispose();
		this.options.onDispose?.();
	}
	private gatewayAction(result: GatewayPanelResult): void {
		if (this.servers.isBusy()) {
			this.notice = "Wait for the server connection or OAuth request to finish before gateway maintenance.";
			this.options.onRender();
			return;
		}
		if (result.action === "diagnose") { void this.validate(); return; }
		if (this.servers.hasChanges()) {
			this.notice = "Save server changes with ctrl+s, or esc to discard, before leaving for gateway setup or repair.";
			this.options.onRender();
			return;
		}
		this.finish(result);
	}
	private async validate(): Promise<void> {
		if (this.busy || this.closed || this.servers.isBusy()) return;
		this.busy = true;
		this.section = "Diagnostics";
		this.notice = undefined;
		this.scroll = 0;
		this.options.onRender();
		try { this.report = await this.options.onValidate(); }
		finally { this.busy = false; if (!this.closed) this.options.onRender(); }
	}
	handleInput(data: string): void {
		if (this.closed) return;
		if (this.tooSmall) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.finish(null);
			return;
		}
		if (this.busy) return; // Validation is bounded; don't hand off stale or incomplete diagnostics.
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			const direction = matchesKey(data, Key.tab) ? 1 : -1;
			this.section = sections[(sections.indexOf(this.section) + direction + sections.length) % sections.length]!;
			this.scroll = 0;
		} else if (matchesKey(data, Key.ctrl("s"))) this.servers.save();
		else if (this.section === "Servers") this.servers.handleInput(data);
		else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) this.finish(null);
		else if (this.section === "Gateway") this.gateway.handleInput(data);
		else if (data === "v" || matchesKey(data, Key.enter)) void this.validate();
		else if (data === "f") this.gatewayAction({ action: "repair" });
		else if (data === "g") this.section = "Gateway";
		else if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
		else if (matchesKey(data, Key.down)) this.scroll++;
		if (!this.closed) this.options.onRender();
	}
	render(width: number): string[] {
		const { theme } = this.options;
		const rows = Math.max(1, this.options.maxRows());
		const inner = Math.max(1, width - 2);
		this.tooSmall = width < 40 || rows < 12;
		if (this.tooSmall) return panelFrame(theme, "MCP", ["Terminal too small.", "Resize to use MCP configuration."], ["esc close"], width, rows);
		const tabLine = sections.map((name) => name === this.section
			? theme.bg("selectedBg", theme.bold(theme.fg("accent", ` ${name} `))) : theme.fg("muted", ` ${name} `)).join(" ");
		const footer = [theme.fg("dim", this.busy ? "Validating external HTTPS…" : "tab section · shift+tab back · esc close")];
		if (this.section === "Servers") {
			footer.push(theme.fg("dim", "↑↓ select · enter expand · space tools"));
			footer.push(theme.fg("dim", "d toggle · r reconnect · a auth · c callback · / search"));
			footer.push(theme.fg("dim", "ctrl+s save servers · g gateway"));
		} else if (this.section === "Gateway") {
			footer.push(theme.fg("dim", "↑↓ select · enter choose · ctrl+s save servers"));
			footer.push(theme.fg("dim", "c custom · d validate · f repair · x deactivate"));
		} else {
			footer.push(theme.fg("dim", "v validate · f ask agent to repair"));
			footer.push(theme.fg("dim", "↑↓ scroll · g gateway · ctrl+s save servers"));
		}
		const notice = this.notice ? wrapTextWithAnsi(theme.fg("warning", this.notice), inner) : [];
		const bodyRows = Math.max(1, rows - footer.length - 5 - notice.length);
		const body = this.section === "Servers" ? this.servers.render(inner, bodyRows, true)
			: this.section === "Gateway" ? this.gateway.render(inner, bodyRows)
			: this.diagnostics(inner, bodyRows);
		return panelFrame(theme, `MCP CONFIGURATION${this.servers.hasChanges() ? " · unsaved" : ""}`,
			[tabLine, theme.fg("borderMuted", "─".repeat(inner)), ...body, ...notice], footer, width, rows);
	}
	private diagnostics(width: number, maxRows: number): string[] {
		const { theme } = this.options;
		const { report } = this;
		const lines = [theme.fg(report.state === "failed" ? "warning" : "text", `${report.mode} · ${report.state}`)];
		if (report.diagnostic) {
			lines.push(`Step: ${report.diagnostic.step} · ${report.diagnostic.code}`, report.diagnostic.summary, `Next: ${report.diagnostic.nextAction}`);
		} else lines.push(report.state === "validated" ? "Exact external HTTPS challenge passed." : "Not validated in this view. Press v to check external HTTPS.");
		if (report.persisted) lines.push("Pi configuration saved through the protected writer.");
		if (report.rollback) lines.push(`Rollback: ${report.rollback}${report.rollback === "failed" ? ". Inspect infrastructure before retrying." : ". Previous settings retained."}`);
		if (report.previousInfrastructurePreserved) lines.push("Previous external infrastructure was left unchanged. Agree on cleanup separately.");
		if (report.restoreDiagnostic) lines.push(report.restoreDiagnostic.summary, report.restoreDiagnostic.nextAction);
		lines.push("Diagnostics omit URLs, credentials and raw command output.");
		const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, width));
		const budget = Math.max(1, maxRows - 1);
		this.scroll = Math.min(this.scroll, Math.max(0, wrapped.length - budget));
		const visible = wrapped.slice(this.scroll, this.scroll + budget);
		if (wrapped.length > budget) visible.push(theme.fg("dim", `${this.scroll + 1}-${Math.min(this.scroll + budget, wrapped.length)} of ${wrapped.length} · ↑↓ scroll`));
		return visible;
	}
	invalidate(): void { this.servers.invalidate(); this.gateway.invalidate(); }
}
