import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { DirectToolsSetting, McpServerControls } from "../config.js";
import type { McpStatusServer, McpStatusTool } from "../mcp/status.js";

interface ServerRow { kind: "server"; server: McpStatusServer; }
interface ToolRow { kind: "tool"; server: McpStatusServer; tool: McpStatusTool; }
type Row = ServerRow | ToolRow;

export type McpPanelResult = { updates: Record<string, McpServerControls> } | { openGateway: true };
export interface McpPanelOptions {
	theme: Theme;
	servers: McpStatusServer[];
	onRender: () => void;
	onDone: (result: McpPanelResult | null) => void;
	onReconnect: (server: string) => Promise<void>;
	onAuthenticate: (server: string) => Promise<string>;
	gatewayConfigured?: boolean;
}

function terminalText(value: string, maximum = 2_000): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, maximum);
}
function settingEqual(left: DirectToolsSetting, right: DirectToolsSetting): boolean {
	if (typeof left === "boolean" || typeof right === "boolean") return left === right;
	return left.length === right.length && left.every((item, index) => item === right[index]);
}
function isSelected(setting: DirectToolsSetting, tool: string): boolean {
	return setting === true || Array.isArray(setting) && setting.includes(tool);
}
function stateColor(state: McpStatusServer["state"]): "success" | "warning" | "error" | "muted" {
	if (state === "connected") return "success";
	if (state === "connecting" || state === "auth-required") return "warning";
	if (state === "error" || state === "invalid") return "error";
	return "muted";
}
function stateIcon(state: McpStatusServer["state"]): string {
	if (state === "connected") return "●";
	if (state === "connecting") return "◐";
	if (state === "auth-required") return "◆";
	if (state === "error" || state === "invalid") return "×";
	if (state === "disabled") return "○";
	return "◌";
}

export class McpPanel implements Component {
	private servers: McpStatusServer[];
	private selected = 0;
	private offset = 0;
	private query = "";
	private searching = false;
	private readonly expanded = new Set<string>();
	private readonly initialDisabled = new Map<string, boolean>();
	private readonly disabled = new Map<string, boolean>();
	private readonly initialDirectTools = new Map<string, DirectToolsSetting>();
	private readonly directTools = new Map<string, DirectToolsSetting>();
	private busy?: string;
	private message?: { text: string; error?: boolean };
	private closed = false;

	constructor(private readonly options: McpPanelOptions) {
		this.servers = options.servers;
		for (const server of options.servers) {
			const disabled = server.state === "disabled";
			this.initialDisabled.set(server.name, disabled);
			this.disabled.set(server.name, disabled);
			this.initialDirectTools.set(server.name, server.directTools);
			this.directTools.set(server.name, server.directTools);
		}
	}

	updateServers(servers: McpStatusServer[]): void {
		if (this.closed) return;
		this.servers = servers;
		for (const server of servers) {
			if (!this.initialDisabled.has(server.name)) {
				const disabled = server.state === "disabled";
				this.initialDisabled.set(server.name, disabled);
				this.disabled.set(server.name, disabled);
				this.initialDirectTools.set(server.name, server.directTools);
				this.directTools.set(server.name, server.directTools);
			}
		}
		this.clampSelection();
		this.options.onRender();
	}

	private rows(): Row[] {
		const query = this.query.toLowerCase().trim();
		const rows: Row[] = [];
		for (const server of this.servers) {
			const matchingTools = server.tools.filter((tool) => !query || `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(query));
			const matchesServer = !query || server.name.toLowerCase().includes(query);
			if (!matchesServer && !matchingTools.length) continue;
			rows.push({ kind: "server", server });
			if (this.expanded.has(server.name) || query) {
				for (const tool of matchesServer && query ? server.tools : matchingTools) rows.push({ kind: "tool", server, tool });
			}
		}
		return rows;
	}

	private clampSelection(): void {
		const length = this.rows().length;
		this.selected = Math.max(0, Math.min(this.selected, Math.max(0, length - 1)));
	}
	private selectedRow(): Row | undefined { return this.rows()[this.selected]; }
	private selectedServer(): McpStatusServer | undefined { return this.selectedRow()?.server; }
	private changed(): boolean {
		return this.servers.some((server) =>
			this.disabled.get(server.name) !== this.initialDisabled.get(server.name) ||
			!settingEqual(this.directTools.get(server.name) ?? false, this.initialDirectTools.get(server.name) ?? false));
	}
	private redraw(): void { if (this.closed) return; this.clampSelection(); this.options.onRender(); }
	private finish(result: McpPanelResult | null): void { if (this.closed) return; this.closed = true; this.options.onDone(result); }

	private toggleExpanded(): void {
		const row = this.selectedRow();
		if (!row) return;
		const name = row.server.name;
		this.expanded.has(name) ? this.expanded.delete(name) : this.expanded.add(name);
		this.redraw();
	}
	private toggleDisabled(): void {
		const server = this.selectedServer();
		if (!server || server.state === "invalid") return;
		this.disabled.set(server.name, !this.disabled.get(server.name));
		this.message = undefined;
		this.redraw();
	}
	private toggleTool(): void {
		const row = this.selectedRow();
		if (!row) return;
		const current = this.directTools.get(row.server.name) ?? false;
		if (row.kind === "server") {
			const allSelected = row.server.tools.length > 0 && row.server.tools.every((tool) => isSelected(current, tool.name));
			this.directTools.set(row.server.name, allSelected ? false : true);
		} else {
			const selected = new Set(Array.isArray(current)
				? current
				: row.server.tools.filter((tool) => isSelected(current, tool.name)).map((tool) => tool.name));
			selected.has(row.tool.name) ? selected.delete(row.tool.name) : selected.add(row.tool.name);
			this.directTools.set(row.server.name, [...selected].sort());
		}
		this.message = undefined;
		this.redraw();
	}
	private async action(kind: "reconnect" | "auth"): Promise<void> {
		const server = this.selectedServer();
		if (!server || this.busy || this.disabled.get(server.name)) return;
		if (server.state === "invalid") {
			this.message = { text: `${terminalText(server.name, 128)} has an invalid MCP configuration.`, error: true };
			this.redraw();
			return;
		}
		if (server.state === "disabled") {
			this.message = { text: `Save and reload before connecting ${server.name}.`, error: true };
			this.redraw();
			return;
		}
		if (kind === "auth" && this.options.gatewayConfigured === false) {
			this.message = { text: "Gateway not configured; press g to configure it.", error: true };
			this.redraw();
			return;
		}
		if (kind === "auth" && server.transport === "stdio") {
			this.message = { text: "OAuth is unavailable for stdio servers.", error: true };
			this.redraw();
			return;
		}
		this.busy = server.name;
		this.message = { text: kind === "auth" ? `Starting OAuth for ${server.name}…` : `Connecting ${server.name}…` };
		this.redraw();
		try {
			if (kind === "auth") {
				const note = await this.options.onAuthenticate(server.name);
				this.message = { text: note };
			} else {
				await this.options.onReconnect(server.name);
				this.message = { text: `${server.name} connected.` };
			}
		} catch {
			this.message = { text: kind === "auth" ? `OAuth could not start for ${server.name}; check /mcp-gateway.` : `${server.name} could not connect.`, error: true };
		} finally {
			this.busy = undefined;
			this.redraw();
		}
	}
	private save(): void {
		const updates: Record<string, McpServerControls> = {};
		for (const server of this.servers) {
			const controls: McpServerControls = {};
			const disabled = this.disabled.get(server.name) ?? false;
			const directTools = this.directTools.get(server.name) ?? false;
			if (disabled !== this.initialDisabled.get(server.name)) controls.disabled = disabled;
			if (!settingEqual(directTools, this.initialDirectTools.get(server.name) ?? false)) controls.directTools = directTools;
			if (controls.disabled !== undefined || controls.directTools !== undefined) updates[server.name] = controls;
		}
		this.finish({ updates });
	}

	handleInput(data: string): void {
		if (this.searching) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) this.searching = false;
			else if (matchesKey(data, Key.backspace)) this.query = this.query.slice(0, -1);
			else if (data.length === 1 && data >= " " && data !== "\x7f") this.query += data;
			this.selected = 0; this.offset = 0; this.redraw(); return;
		}
		if (matchesKey(data, Key.escape)) { this.finish(null); return; }
		if (matchesKey(data, Key.up)) this.selected--;
		else if (matchesKey(data, Key.down)) this.selected++;
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) this.toggleExpanded();
		else if (matchesKey(data, Key.left)) { const server = this.selectedServer(); if (server) this.expanded.delete(server.name); }
		else if (matchesKey(data, Key.space)) this.toggleTool();
		else if (matchesKey(data, Key.ctrl("s"))) { this.save(); return; }
		else if (data === "/") { this.searching = true; this.query = ""; }
		else if (data === "d") this.toggleDisabled();
		else if (data === "r") { void this.action("reconnect"); return; }
		else if (data === "a") { void this.action("auth"); return; }
		else if (data === "g" && this.options.gatewayConfigured === false) { this.finish({ openGateway: true }); return; }
		this.redraw();
	}

	render(width: number): string[] {
		const theme = this.options.theme;
		const usable = Math.max(1, width);
		const rows = this.rows();
		const pageSize = 16;
		if (this.selected < this.offset) this.offset = this.selected;
		if (this.selected >= this.offset + pageSize) this.offset = this.selected - pageSize + 1;
		const visible = rows.slice(this.offset, this.offset + pageSize);
		const line = (value: string) => truncateToWidth(value, usable);
		const output = [
			line(theme.fg("accent", theme.bold("MCP Servers")) + theme.fg("dim", this.changed() ? "  • unsaved" : "")),
			line(theme.fg(this.searching ? "accent" : "dim", `Search: ${this.query}${this.searching ? "▌" : "(press /)"}`)),
			line(theme.fg("borderMuted", "─".repeat(usable))),
		];
		if (!visible.length) output.push(line(theme.fg("muted", "No matching MCP servers.")));
		for (let index = 0; index < visible.length; index++) {
			const row = visible[index]!;
			const absolute = this.offset + index;
			let content: string;
			if (row.kind === "server") {
				const stagedDisabled = this.disabled.get(row.server.name) ?? false;
				const state = stagedDisabled ? "disabled" : row.server.state;
				const expanded = this.expanded.has(row.server.name) || !!this.query;
				const counts = row.server.counts;
				content = `${expanded ? "▾" : "▸"} ${theme.fg(stateColor(state), stateIcon(state))} ${theme.bold(terminalText(row.server.name, 128))} ` +
					theme.fg("muted", `${state} · ${row.server.transport} · ${counts.tools}t ${counts.resources + counts.resourceTemplates}r ${counts.prompts}p`);
			} else {
				const setting = this.directTools.get(row.server.name) ?? false;
				const checked = isSelected(setting, row.tool.name);
				content = `    ${checked ? theme.fg("success", "◉") : theme.fg("dim", "○")} ${terminalText(row.tool.name, 256)}`;
				if (row.tool.description) content += theme.fg("dim", ` — ${terminalText(row.tool.description.replace(/\s+/g, " "))}`);
			}
			const clipped = line(content);
			output.push(absolute === this.selected ? theme.bg("selectedBg", clipped + " ".repeat(Math.max(0, usable - visibleWidth(clipped)))) : clipped);
		}
		if (rows.length > pageSize) output.push(line(theme.fg("dim", `${this.offset + 1}-${Math.min(this.offset + pageSize, rows.length)} of ${rows.length}`)));
		if (this.message) output.push(line(theme.fg(this.message.error ? "error" : "accent", this.message.text)));
		output.push(line(theme.fg("borderMuted", "─".repeat(usable))));
		output.push(line(theme.fg("dim", `↑↓ navigate  enter expand  space tools  d toggle  r reconnect  a auth${this.options.gatewayConfigured === false ? "  g gateway" : ""}  / search  ctrl+s save  esc cancel`)));
		return output;
	}

	invalidate(): void { /* rendering is derived from the injected live theme */ }
}
