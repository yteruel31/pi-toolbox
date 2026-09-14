import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SettingsList, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayOptions } from "@earendil-works/pi-tui";
import type { Config, ConfigSnapshot, Policy } from "../config.js";
import { thinkingLevels } from "../config.js";
import { decisionCategory, filterHistory, type HistoryFilter, type HistoryStore } from "../history.js";
import type { HistoryEntry } from "../types.js";
import { sanitize } from "../sanitize.js";

export const GUARDRAILS_OVERLAY: OverlayOptions = { width: "90%", maxHeight: "95%", anchor: "center", margin: 1 };
export const panelRows = (rows: number) => Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.95)));
export type PanelAction = { type: "close" | "save" | "model" | "new" | "presets" | "test" } | { type: "edit"; id: string };
export interface PanelState {
  tab: "Setup" | "Policies" | "History";
  global: boolean;
  selectedId?: string;
  policyId?: string;
  filter: HistoryFilter;
  detail: boolean;
  scroll: number;
  notice?: string;
}
export const initialPanelState = (): PanelState => ({ tab: "Setup", global: false, filter: {}, detail: false, scroll: 0 });
interface Options {
  theme: Theme;
  keybindings: KeybindingsManager;
  snapshot: ConfigSnapshot;
  draft: Config;
  history: HistoryStore;
  sessionId: string;
  model: () => string;
  state: PanelState;
  maxRows: () => number;
  onRender: () => void;
  onDone: (action: PanelAction) => void;
}
const tabs = ["Setup", "Policies", "History"] as const;
const categories = [undefined, "auto", "human", "attention", "denied"] as const;
export function actorLabel(e: HistoryEntry): string { return e.actor.kind === "main" ? "Main" : `Subagent · ${e.actor.profile ?? "generic"}/${e.actor.runId}`; }
export function decisionIcon(e: HistoryEntry, theme: Theme): string {
  const c = decisionCategory(e);
  return theme.fg(c === "auto" ? "success" : c === "human" ? "accent" : c === "attention" ? "warning" : "error", c === "auto" || c === "human" ? "✓" : c === "attention" ? "!" : "✕");
}
export function historyDetail(e: HistoryEntry): string[] {
  return [e.summary, "", `Decision: ${e.action} · ${e.origin}`, `State: ${e.state}`, `Reason: ${e.reason}`,
    `Human choice: ${e.choice ?? "none (automatic decision)"}`, `Execution: ${e.execution} (Pi observation only)`,
    `Actor: ${actorLabel(e)}`, `Project: ${e.project}`, `Session: ${e.sessionId}`, `Cwd: ${e.cwd}`,
    `Child session: ${e.actor.kind === "subagent" ? e.actor.childSessionId ?? "not reported" : "not applicable"}`,
    `Branch leaf: ${e.leafId ?? "not recorded"}`, `Policies: ${e.policyIds.join(", ") || "none"}`,
    `Model: ${e.model ? `${e.model.route} · thinking ${e.model.thinking} · ${e.model.durationMs}ms` : "not called"}`,
    `History references: ${e.historyIds.join(", ") || "none"}`, `Event: ${e.id}`, new Date(e.at).toISOString(),
    "Past decisions do not grant future permissions."];
}
/** Fixed-height native overlay; history ordering freezes until an explicit refresh. */
export class GuardrailsPanel implements Component, Focusable {
  private input = new Input();
  private searching = false;
  private closed = false;
  private tooSmall = false;
  private wide = false;
  private listOffset = 0;
  private rows: HistoryEntry[];
  private newCount = 0;
  private seen: Set<string>;
  private unsubscribe: () => void;
  private settings: SettingsList;
  private paste = false;
  focused = false;
  constructor(private o: Options) {
    this.rows = o.history.list();
    this.seen = new Set(this.rows.map((e) => e.id));
    this.unsubscribe = o.history.subscribe(() => this.update());
    this.input.setValue(o.state.filter.search ?? "");
    const theme = o.theme;
    this.settings = new SettingsList([
      { id: "enabled", label: "Protection", currentValue: o.draft.enabled ? "enabled" : "disabled", values: ["disabled", "enabled"] },
      { id: "thinking", label: "Judge thinking", currentValue: o.draft.thinking, values: [...thinkingLevels] },
      { id: "errorBehavior", label: "On judge error", currentValue: o.draft.errorBehavior, values: ["ask", "deny"] },
      { id: "timeoutMs", label: "Judge timeout (ms)", currentValue: String(o.draft.timeoutMs), values: ["5000", "15000", "30000", "60000"] },
      { id: "maxOutputTokens", label: "Output token cap", currentValue: String(o.draft.maxOutputTokens), values: ["512", "1024", "2048", "4096"] },
    ], 5, {
      label: (t, selected) => theme.fg(selected ? "accent" : "text", t), value: (t) => theme.fg("muted", t),
      description: (t) => theme.fg("muted", t), cursor: theme.fg("accent", "▸ "), hint: (t) => theme.fg("dim", t),
    }, (id, value) => {
      if (id === "enabled") o.draft.enabled = value === "enabled";
      else if (id === "thinking") o.draft.thinking = value as Config["thinking"];
      else if (id === "errorBehavior") o.draft.errorBehavior = value as Config["errorBehavior"];
      else if (id === "timeoutMs" || id === "maxOutputTokens") o.draft[id] = Number(value);
    }, () => this.finish({ type: "close" }));
  }
  private update(): void {
    if (this.closed) return;
    const latest = this.o.history.list();
    const byId = new Map(latest.map((e) => [e.id, e]));
    this.rows = this.rows.flatMap((e) => byId.has(e.id) ? [byId.get(e.id)!] : []);
    this.newCount = latest.filter((e) => !this.seen.has(e.id)).length;
    this.o.onRender();
  }
  dispose(): void { if (!this.closed) { this.closed = true; this.unsubscribe(); } }
  private finish(action: PanelAction): void { this.dispose(); this.o.onDone(action); }
  private policies(): Policy[] { return [...this.o.draft.policies, ...this.o.snapshot.policies.filter((p) => p.source === "project")]; }
  private filtered(): HistoryEntry[] { return filterHistory(this.rows, { ...this.o.state.filter, sessionId: this.o.state.global ? undefined : this.o.sessionId }); }
  private selectMove(delta: number): void {
    const s = this.o.state;
    const ids = s.tab === "Policies" ? this.policies().map((p) => p.id) : this.filtered().map((e) => e.id);
    const selected = s.tab === "Policies" ? s.policyId : s.selectedId;
    const index = Math.max(0, ids.indexOf(selected ?? ""));
    const id = ids[Math.min(ids.length - 1, Math.max(0, index + delta))];
    if (s.tab === "Policies") s.policyId = id; else s.selectedId = id;
    s.scroll = 0;
  }
  handleInput(data: string): void {
    if (this.closed) return;
    // Pasted text is data, never a sequence of save/edit/approval keystrokes.
    if (this.paste || data.includes("\x1b[200~")) { this.paste = !data.includes("\x1b[201~"); return; }
    const s = this.o.state;
    const kb = this.o.keybindings;
    const esc = matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || kb.matches(data, "tui.select.cancel");
    if (this.searching) {
      if (esc || matchesKey(data, "enter")) this.searching = false;
      else { this.input.handleInput(data); this.input.setValue(sanitize(this.input.getValue(), 200)); s.filter.search = this.input.getValue(); this.listOffset = 0; }
    } else if (esc) {
      if (s.detail) { s.detail = false; s.scroll = 0; }
      else { this.finish({ type: "close" }); return; }
    } else if (this.tooSmall) return;
    else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      s.tab = tabs[(tabs.indexOf(s.tab) + (matchesKey(data, "tab") ? 1 : 2)) % 3]; s.detail = false; s.scroll = 0; this.listOffset = 0;
    } else if (matchesKey(data, "ctrl+s")) { this.finish({ type: "save" }); return; }
    else if (s.tab === "Setup") {
      if (data === "m") { this.finish({ type: "model" }); return; }
      if (matchesKey(data, "pageDown")) s.scroll++;
      else if (matchesKey(data, "pageUp")) s.scroll = Math.max(0, s.scroll - 1);
      else { this.settings.handleInput(data); s.scroll = 0; }
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) s.scroll = Math.max(0, s.scroll + (matchesKey(data, "pageDown") ? 5 : -5));
    else if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down") || matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = kb.matches(data, "tui.select.up") || matchesKey(data, "up") ? -1 : 1;
      if (s.detail) s.scroll = Math.max(0, s.scroll + delta); else this.selectMove(delta);
    } else if (matchesKey(data, "enter") || kb.matches(data, "tui.select.confirm")) { s.detail = !s.detail; s.scroll = 0; }
    else if (s.tab === "Policies") {
      if (["n", "p", "t"].includes(data)) { this.finish({ type: data === "n" ? "new" : data === "p" ? "presets" : "test" }); return; }
      const policy = this.policies().find((p) => p.id === s.policyId) ?? this.policies()[0];
      if (policy && policy.source !== "project") {
        if (data === "e") { this.finish({ type: "edit", id: policy.id }); return; }
        if (data === " ") policy.enabled = !policy.enabled;
        if (data === "a") policy.action = (["Allow", "Ask", "Deny"] as const)[(["Allow", "Ask", "Deny"].indexOf(policy.action) + 1) % 3];
        if (data === "s") policy.scope = (["main", "subagent", "both"] as const)[(["main", "subagent", "both"].indexOf(policy.scope) + 1) % 3];
      }
    } else if (s.tab === "History") {
      if (data === "/") this.searching = true;
      if (data === "g") { s.global = !s.global; this.listOffset = 0; s.scroll = 0; }
      if (data === "a") { s.filter.actor = s.filter.actor === undefined ? "main" : s.filter.actor === "main" ? "subagent" : undefined; this.listOffset = 0; }
      if (data === "d") { s.filter.decision = categories[(categories.indexOf(s.filter.decision) + 1) % categories.length]; this.listOffset = 0; }
      if (data === "n") { this.rows = this.o.history.list(); this.seen = new Set(this.rows.map((e) => e.id)); this.newCount = 0; }
    }
    this.o.onRender();
  }
  private scrollLines(lines: string[], width: number, rows: number): string[] {
    const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, width));
    const budget = Math.max(1, rows - 1);
    this.o.state.scroll = Math.min(this.o.state.scroll, Math.max(0, wrapped.length - budget));
    const offset = this.o.state.scroll;
    return [...wrapped.slice(offset, offset + budget), ...(wrapped.length > budget ? [this.o.theme.fg("dim", `${offset + 1}-${Math.min(wrapped.length, offset + budget)}/${wrapped.length} · PgUp/PgDn`)] : [])];
  }
  private listAndDetail(items: { id: string; lines: string[] }[], selectedId: string | undefined, details: string[], width: number, rows: number): string[] {
    const s = this.o.state;
    if (s.detail) return this.scrollLines(details, width, rows);
    const listWidth = this.wide ? Math.floor(width * 0.52) : width;
    const selectedIndex = Math.max(0, items.findIndex((e) => e.id === selectedId));
    const blocks = items.map((e, i) => e.lines.flatMap((line) => wrapTextWithAnsi(line, listWidth - 2)).map((line, j) => {
      const text = `${i === selectedIndex && j === 0 ? "▸ " : "  "}${line}`;
      return i === selectedIndex ? this.o.theme.bg("selectedBg", text) : text;
    }));
    const selectedStart = blocks.slice(0, selectedIndex).reduce((n, b) => n + b.length, 0);
    const selectedEnd = selectedStart + (blocks[selectedIndex]?.length ?? 1);
    if (selectedStart < this.listOffset) this.listOffset = selectedStart;
    if (selectedEnd > this.listOffset + rows - 1) this.listOffset = Math.max(0, selectedStart - Math.max(0, rows - 1 - (blocks[selectedIndex]?.length ?? 1)));
    const flat = blocks.flat();
    const list = flat.slice(this.listOffset, this.listOffset + rows - 1);
    if (!items.length) list.push(this.o.theme.fg("muted", "No matching entries."));
    if (flat.length > rows - 1) list.push(this.o.theme.fg("dim", `${selectedIndex + 1}/${items.length} · ↑↓ select`));
    if (!this.wide) return list;
    const rightWidth = width - listWidth - 3;
    const detail = this.scrollLines(details, rightWidth, rows);
    return Array.from({ length: rows }, (_, i) => pad(list[i] ?? "", listWidth) + this.o.theme.fg("borderMuted", " │ ") + pad(detail[i] ?? "", rightWidth));
  }
  render(width: number): string[] {
    const rows = this.o.maxRows();
    this.tooSmall = width < 32 || rows < 12;
    if (this.tooSmall) return ["Guardrails: resize terminal", "Minimum panel: 32 x 12", "Esc close"].slice(0, rows).map((s) => truncateToWidth(s, width, ""));
    const inner = width - 4;
    this.wide = inner >= 100;
    const { theme, state: s } = this.o;
    const header = tabs.map((t) => t === s.tab ? theme.bg("selectedBg", theme.fg("accent", theme.bold(` ${t} `))) : theme.fg("muted", ` ${t} `)).join(" ");
    const foot = ["Tab section · Ctrl+s save · Esc back/close",
      s.tab === "Setup" ? "↑↓ setting · Enter change · m model · PgDn more" : s.tab === "Policies" ? "↑↓ select · Enter detail · e edit · n new · p presets · t test" : "↑↓ select · Enter detail · / search · g current/global",
      s.tab === "Policies" ? "Space enabled · a action · s actor · PgUp/PgDn detail" : s.tab === "History" ? "a actor · d decision · n new events · PgUp/PgDn detail" : "Changes are staged until Ctrl+s."].flatMap((l) => wrapTextWithAnsi(l, inner));
    const bodyRows = Math.max(1, rows - foot.length - 5);
    let body: string[];
    if (s.tab === "Setup") {
      const lines = [...this.settings.render(inner), "", `Resolved model: ${sanitize(this.o.model(), 220)}`,
        `Model route: ${this.o.draft.model || "active parent Pi model"}`, "Independent judge thinking defaults to off.",
        "Worker Ask and headless Ask always block. Main Ask requires approval.", `Configuration: ${this.o.snapshot.error ?? "valid"}`, this.o.snapshot.projectStatus,
        "Global settings own activation, model and policies. Project config only adds restrictions.",
        "Coverage: main and Pi child bash/read/write/edit. Not an OS sandbox. Claude is unchanged.",
        "History records decisions and reported results, not a tamper-proof security audit.", ...(s.notice ? ["", sanitize(s.notice)] : [])];
      body = this.scrollLines(lines, inner, bodyRows);
    } else if (s.tab === "Policies") {
      const policies = this.policies();
      const selected = policies.find((p) => p.id === s.policyId) ?? policies[0];
      if (selected) s.policyId = selected.id;
      const details = selected ? [sanitize(selected.name), `Source: ${selected.source ?? "global"}`, `Enabled: ${selected.enabled}`, `Actor: ${selected.scope}`, `Action: ${selected.action}`, `Tools: ${selected.tools.join(", ")}`, `Kind: ${selected.kind}`, `Conditions: ${sanitize(JSON.stringify(selected.conditions))}`, sanitize(selected.description ?? ""), "Deny > Ask > Allow. Hard restrictions cannot be weakened by the model.", "Persistent exceptions are explicit Allow policies. They never override Ask/Deny.", ...(s.notice ? ["", sanitize(s.notice)] : [])] : ["No policies. Press p for presets or n to add a policy.", sanitize(s.notice ?? "")];
      body = this.listAndDetail(policies.map((p) => ({ id: p.id, lines: [`${p.enabled ? "●" : "○"} ${sanitize(p.name)}`, `${p.action} · ${p.scope} · ${p.source ?? "global"}`] })), s.policyId, details, inner, bodyRows);
    } else {
      const filtered = this.filtered();
      const selected = filtered.find((e) => e.id === s.selectedId) ?? filtered[0];
      if (selected) s.selectedId = selected.id;
      const sub = `${s.global ? "Current session   [Global]" : "[Current session]   Global"} · ${filtered.length}${this.newCount ? ` · +${this.newCount} new (n)` : ""}`;
      const filters = `Actor: ${s.filter.actor ?? "all"} · Decision: ${s.filter.decision ?? "all"}`;
      this.input.focused = this.focused && this.searching;
      const search = this.searching ? this.input.render(inner) : wrapTextWithAnsi(`Search: ${s.filter.search || "/ to search"}`, inner);
      const top = [...wrapTextWithAnsi(sub, inner), ...wrapTextWithAnsi(filters, inner), ...search];
      body = [...top, ...this.listAndDetail(filtered.map((e) => ({ id: e.id, lines: [
        `${new Date(e.at).toLocaleTimeString()} ${decisionIcon(e, theme)} ${actorLabel(e)} · ${e.tool}`, e.summary,
      ] })), s.selectedId, selected ? historyDetail(selected) : ["No matching history."], inner, Math.max(1, bodyRows - top.length))];
    }
    while (body.length < bodyRows) body.push("");
    const row = (line: string) => theme.fg("borderMuted", "│ ") + pad(line, inner) + theme.fg("borderMuted", " │");
    const title = theme.fg("accent", theme.bold(" GUARDRAILS "));
    return [theme.fg("borderAccent", "╭") + title + theme.fg("borderAccent", "─".repeat(Math.max(0, width - visibleWidth(title) - 2)) + "╮"), row(header), row(theme.fg("borderMuted", "─".repeat(inner))),
      ...body.slice(0, bodyRows).map(row), theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`), ...foot.map((f) => row(theme.fg("dim", f))), theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`)].map((l) => truncateToWidth(l, width, ""));
  }
  invalidate(): void { this.input.invalidate(); this.settings.invalidate(); }
}
function pad(line: string, width: number): string {
  const text = truncateToWidth(line, Math.max(1, width), "");
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}
