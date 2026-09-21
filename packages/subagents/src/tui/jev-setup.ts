import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayOptions } from "@earendil-works/pi-tui";
import { jevStorageErrorMessage, type JevCredentialSource, type JevSetupSnapshot } from "../agents/jev-config.js";
import { SecretInput } from "./secret-input.js";

export const JEV_SETUP_OVERLAY: OverlayOptions = { width: 72, minWidth: 32, maxHeight: "85%", anchor: "center", margin: 1 };
export function jevSetupRows(terminalRows: number): number { return Math.max(1, Math.min(22, Math.floor(terminalRows * 0.85) - 2)); }
export interface JevSetupDraft { enabled: boolean; source: JevCredentialSource; reference?: string; key?: string; }
interface Options {
  theme: Theme; keybindings: KeybindingsManager; snapshot: JevSetupSnapshot; defaultFile: string; maxRows(): number;
  onRender(): void; onDone(saved: boolean): void; onSave(draft: JevSetupDraft): Promise<void>;
  onTest(draft: JevSetupDraft, signal: AbortSignal): Promise<void>;
}
type Field = "enabled" | "source" | "reference" | "key" | "review";
const sources: JevCredentialSource[] = ["environment", "keyring", "file"];

/** Staged Jev setup. Only explicit Test reads credentials and only explicit Save writes them. */
export class JevSetupPanel implements Component, Focusable {
  focused = false;
  private enabled: boolean;
  private source: JevCredentialSource;
  private references: Record<"environment" | "file", string>;
  private reference = new Input();
  private secret = new SecretInput();
  private field: Field = "enabled";
  private editing = false;
  private busy?: "test" | "save";
  private testController?: AbortController;
  private notice?: string;
  private closed = false;
  private scroll = 0;
  private paste: string | undefined;
  private tooSmall = false;
  constructor(private options: Options) {
    const config = options.snapshot.config;
    this.enabled = config?.enabled ?? false;
    this.source = config?.credential.source ?? "environment";
    this.references = {
      environment: config?.credential.source === "environment" ? config.credential.value : "JEV_API_KEY",
      file: config?.credential.source === "file" ? config.credential.value : options.defaultFile,
    };
    this.syncReference();
  }
  private fields(): Field[] { return ["enabled", "source", ...(this.source === "keyring" ? [] : ["reference"] as Field[]), ...(this.source === "environment" ? [] : ["key"] as Field[]), "review"]; }
  private syncReference(): void { this.reference = new Input(); if (this.source !== "keyring") this.reference.setValue(this.references[this.source]); }
  private commitReference(): void { if (this.source !== "keyring") this.references[this.source] = this.reference.getValue().trim(); }
  private redraw(): void { if (!this.closed) this.options.onRender(); }
  private draft(): JevSetupDraft {
    return { enabled: this.enabled, source: this.source, reference: this.source === "keyring" ? "pi-subagents/jev" : this.reference.getValue().trim(), key: this.secret.getValue() || undefined };
  }
  private invalidDraft(): boolean {
    const draft = this.draft();
    if (this.secret.invalid) { this.notice = "Key not accepted: paste a printable key without whitespace (max 16384). Nothing was used."; return true; }
    if (draft.source !== "environment" && !draft.key && this.options.snapshot.config?.credential.source !== draft.source) {
      this.notice = `Enter a key for the newly selected ${draft.source === "file" ? "private file" : "keyring"}; another source will not be read.`; return true;
    }
    if (draft.source === "environment" && !/^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(draft.reference ?? "")) {
      this.notice = "Use a valid environment variable name (for example JEV_API_KEY or TYPESAFE_API_KEY; max 256 characters)."; return true;
    }
    if (draft.source === "file" && !(draft.reference ?? "").startsWith("/")) { this.notice = "Choose an absolute private credential file path outside repositories."; return true; }
    return false;
  }
  private finish(saved: boolean): void { if (this.closed) return; this.dispose(); this.options.onDone(saved); }
  async act(kind: "save" | "test"): Promise<void> {
    if (this.closed || this.busy || this.invalidDraft()) { this.redraw(); return; }
    this.busy = kind; this.notice = undefined;
    const controller = kind === "test" ? new AbortController() : undefined;
    this.testController = controller; this.redraw();
    try {
      if (kind === "save") { await this.options.onSave(this.draft()); this.finish(true); }
      else { await this.options.onTest(this.draft(), controller!.signal); if (!this.closed && !controller!.signal.aborted) this.notice = "Connection succeeded. Nothing was saved."; }
    } catch (error) {
      if (!this.closed && !(kind === "test" && controller?.signal.aborted)) this.notice = jevStorageErrorMessage(error);
    } finally {
      if (!this.closed && this.testController === controller) { this.testController = undefined; this.busy = undefined; this.redraw(); }
    }
  }
  handleInput(data: string): void {
    if (this.closed) return;
    const cancel = this.options.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
    if (this.busy === "test") { if (cancel) { this.testController?.abort(); this.notice = "Connection test cancelled. Nothing was saved."; this.busy = undefined; this.testController = undefined; this.redraw(); } return; }
    if (this.busy === "save") return;
    if ((this.paste !== undefined || data.startsWith("\x1b[200~")) && !(this.editing && this.field === "key")) {
      const combined = (this.paste ?? "") + data; this.paste = combined.includes("\x1b[201~") ? undefined : combined.slice(-5); return;
    }
    if (this.editing && this.field === "key" && this.secret.consumePaste(data)) { this.notice = this.secret.invalid ? "Key not accepted: paste a printable key without whitespace (max 16384). Nothing was used." : undefined; this.redraw(); return; }
    if (cancel) {
      if (this.editing) { this.editing = false; this.syncReference(); this.secret.clear(); }
      else this.finish(false);
      this.redraw(); return;
    }
    if (this.tooSmall) return;
    if (this.editing && this.field === "key") { if (matchesKey(data, "enter")) this.editing = false; else this.secret.handleInput(data); this.notice = this.secret.invalid ? "Key not accepted: paste a printable key without whitespace (max 16384). Nothing was used." : undefined; this.redraw(); return; }
    if (this.editing && this.field === "reference") { if (matchesKey(data, "enter")) { this.commitReference(); this.editing = false; } else this.reference.handleInput(data); this.redraw(); return; }
    const fields = this.fields();
    const next = matchesKey(data, "down") || matchesKey(data, "tab");
    const previous = matchesKey(data, "up") || matchesKey(data, "shift+tab");
    if (next || previous) this.field = fields[(fields.indexOf(this.field) + (next ? 1 : -1) + fields.length) % fields.length]!;
    else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      if (this.field === "enabled") this.enabled = !this.enabled;
      if (this.field === "source") { const offset = matchesKey(data, "right") ? 1 : -1; this.source = sources[(sources.indexOf(this.source) + offset + sources.length) % sources.length]!; this.secret.clear(); this.syncReference(); }
    } else if (matchesKey(data, "t")) void this.act("test");
    else if (matchesKey(data, "ctrl+s") || this.field === "review" && matchesKey(data, "enter")) void this.act("save");
    else if (matchesKey(data, "enter") && (this.field === "reference" || this.field === "key")) this.editing = true;
    else if (matchesKey(data, "pageDown")) this.scroll++;
    else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 1);
    this.redraw();
  }
  private body(width: number): string[] {
    const selected = (field: Field, text: string) => field === this.field ? this.options.theme.bg("selectedBg", this.options.theme.fg("accent", `▸ ${text}`)) : `  ${text}`;
    const rows = [
      "Nothing is read or written until an explicit Test or Save.",
      "Save changes local settings only; run /reload to apply routing. It sends no task.", "",
      selected("enabled", `Routing: ${this.enabled ? "Enabled" : "Disabled"}`),
      selected("source", `Credential source: ${this.source}`),
    ];
    if (this.source === "keyring") rows.push("  Keyring: pi-subagents / jev (display only)", "  Requires libsecret-tools, session D-Bus, and an unlocked collection; no file fallback.");
    else {
      rows.push(selected("reference", this.source === "environment" ? "Environment reference" : "Private file (absolute, mode 0600)"));
      this.reference.focused = this.focused && this.editing && this.field === "reference";
      rows.push(...this.reference.render(Math.max(1, width - 2)).map((line) => `  ${line}`));
    }
    if (this.source !== "environment") {
      rows.push(selected("key", "API key (masked; blank keeps the matching saved credential)"));
      this.secret.focused = this.focused && this.editing && this.field === "key";
      rows.push(...this.secret.render(Math.max(1, width - 2)).map((line) => `  ${line}`));
    }
    rows.push("", selected("review", "Review and Save"), "", "Test may charge for one tiny synthetic request. No key is sent through chat.");
    if (this.notice) rows.push("", this.options.theme.fg("warning", this.notice));
    return rows.flatMap((line) => wrapTextWithAnsi(line, width));
  }
  render(width: number): string[] {
    width = Math.max(1, width); const rows = Math.max(1, this.options.maxRows()); this.tooSmall = width < 32 || rows < 10;
    if (this.tooSmall) return ["Jev Setup: resize terminal", "Minimum panel: 32 x 10", "Esc cancel"].slice(0, rows).map((line) => truncateToWidth(line, width, ""));
    const inner = width - 4; const theme = this.options.theme;
    const row = (line: string) => { const text = truncateToWidth(line, inner, ""); return theme.fg("borderMuted", "│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + theme.fg("borderMuted", " │"); };
    const title = theme.fg("accent", theme.bold(" Jev Setup "));
    const top = theme.fg("borderAccent", "╭") + title + theme.fg("borderAccent", "─".repeat(Math.max(0, width - visibleWidth(title) - 2)) + "╮");
    const footer = this.busy === "save" ? ["Saving locally (commit phase; cannot be cancelled)…"] : this.busy === "test" ? ["Testing synthetic request… Esc/Ctrl+C cancel"] : ["Up/Down or Tab fields | Left/Right change | Enter edit/save", "t test | Ctrl+s save | Esc cancel edit/form | PgUp/PgDn scroll"];
    const wrappedFooter = footer.flatMap((line) => wrapTextWithAnsi(line, inner)); const body = this.body(inner); const budget = Math.max(1, rows - wrappedFooter.length - 4);
    const focus = body.findIndex((line) => line.includes("▸")); if (focus >= 0) this.scroll = Math.max(this.scroll, focus >= budget ? focus - budget + 1 : 0);
    if (this.notice) this.scroll = Math.max(this.scroll, body.length - budget);
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - budget)); const content = body.slice(this.scroll, this.scroll + budget);
    return [top, ...content.map(row), theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`), ...wrappedFooter.map((line) => row(theme.fg("dim", line))), theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`)];
  }
  invalidate(): void { this.reference.invalidate(); this.secret.invalidate(); }
  dispose(): void { if (this.closed) return; this.closed = true; this.testController?.abort(); this.testController = undefined; this.secret.dispose(); this.reference = new Input(); this.paste = undefined; }
}
