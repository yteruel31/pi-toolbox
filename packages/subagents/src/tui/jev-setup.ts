import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayOptions } from "@earendil-works/pi-tui";
import type { JevCredentialSource, StoredJevConfig } from "../agents/jev-config.js";
import { SecretInput } from "./secret-input.js";

export const JEV_SETUP_OVERLAY: OverlayOptions = { width: 72, minWidth: 32, maxHeight: "85%", anchor: "center", margin: 1 };
export interface JevSetupDraft { enabled: boolean; source: JevCredentialSource; reference?: string; key?: string; }
interface Options { theme: Theme; keybindings: KeybindingsManager; config?: StoredJevConfig; onRender(): void; onDone(saved: boolean): void; onSave(draft: JevSetupDraft): Promise<void>; onTest(draft: JevSetupDraft, signal: AbortSignal): Promise<void>; }
type Field = "enabled" | "source" | "reference" | "key" | "review";
const sources: JevCredentialSource[] = ["environment", "keyring", "file"];

/** A staged Jev setup form. Escape always discards unsaved settings and secrets. */
export class JevSetupPanel implements Component, Focusable {
  focused = false;
  private enabled: boolean;
  private source: JevCredentialSource;
  private reference: Input;
  private secret = new SecretInput();
  private field: Field = "enabled";
  private editing = false;
  private busy = false;
  private notice?: string;
  private closed = false;
  constructor(private options: Options) {
    this.enabled = options.config?.enabled ?? false;
    this.source = options.config?.credential.source ?? "environment";
    this.reference = new Input();
    this.reference.setValue(options.config?.credential.source === "environment" || options.config?.credential.source === "file" ? options.config.credential.value : "JEV_API_KEY");
  }
  private fields(): Field[] { return ["enabled", "source", "reference", ...(this.source === "environment" ? [] : ["key"] as Field[]), "review"]; }
  private redraw(): void { if (!this.closed) this.options.onRender(); }
  private draft(): JevSetupDraft { return { enabled: this.enabled, source: this.source, reference: this.reference.getValue().trim(), key: this.secret.getValue() || undefined }; }
  private finish(saved: boolean): void { if (this.closed) return; this.dispose(); this.options.onDone(saved); }
  async act(kind: "save" | "test"): Promise<void> {
    this.busy = true; this.notice = undefined; this.redraw();
    const controller = new AbortController();
    try { if (kind === "save") { await this.options.onSave(this.draft()); this.finish(true); } else { await this.options.onTest(this.draft(), controller.signal); this.notice = "Connection succeeded. Nothing was saved."; } }
    catch { this.notice = kind === "save" ? "Save failed. Settings are unchanged unless the key storage step already succeeded." : "Connection failed. Check the key and storage prerequisites."; }
    finally { this.busy = false; this.redraw(); }
  }
  handleInput(data: string): void {
    if (this.closed || this.busy) return;
    const cancel = this.options.keybindings.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
    if (cancel) { if (this.editing) this.editing = false; else this.finish(false); this.redraw(); return; }
    if (this.editing && this.field === "key") { if (matchesKey(data, "enter")) this.editing = false; else this.secret.handleInput(data); this.redraw(); return; }
    if (this.editing && this.field === "reference") { if (matchesKey(data, "enter")) this.editing = false; else this.reference.handleInput(data); this.redraw(); return; }
    if (matchesKey(data, "up") || matchesKey(data, "down")) { const fields = this.fields(); const delta = matchesKey(data, "down") ? 1 : -1; this.field = fields[(fields.indexOf(this.field) + delta + fields.length) % fields.length]!; }
    else if (matchesKey(data, "left") || matchesKey(data, "right")) { if (this.field === "enabled") this.enabled = !this.enabled; if (this.field === "source") this.source = sources[(sources.indexOf(this.source) + (matchesKey(data, "right") ? 1 : 2)) % 3]!; }
    else if (matchesKey(data, "t")) void this.act("test");
    else if (matchesKey(data, "ctrl+s") || this.field === "review" && matchesKey(data, "enter")) void this.act("save");
    else if (matchesKey(data, "enter") && (this.field === "reference" || this.field === "key")) this.editing = true;
    this.redraw();
  }
  render(width: number): string[] {
    const theme = this.options.theme; width = Math.max(1, width); const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width - 4));
    this.secret.focused = this.focused && this.editing && this.field === "key"; this.reference.focused = this.focused && this.editing && this.field === "reference";
    const rows = ["Jev automatic routing Setup", "", "Nothing is written until Save. Escape cancels and clears the staged key.", "", ` ${this.field === "enabled" ? "▸" : " "} Routing: ${this.enabled ? "Enabled" : "Disabled"}`, ` ${this.field === "source" ? "▸" : " "} Credential source: ${this.source}`];
    rows.push(` ${this.field === "reference" ? "▸" : " "} ${this.source === "environment" ? "Environment variable" : "Private file"}:`);
    if (this.source === "keyring") rows.push("   pi-subagents / jev"); else rows.push(...this.reference.render(Math.max(1, width - 6)).map((line) => `   ${line}`));
    if (this.source !== "environment") { rows.push(` ${this.field === "key" ? "▸" : " "} API key (masked):`); rows.push(...this.secret.render(Math.max(1, width - 6)).map((line) => `   ${line}`)); }
    rows.push("", ` ${this.field === "review" ? "▸" : " "} Review and Save`, "", this.busy ? "Working..." : "Up/Down fields | Left/Right change | Enter edit/save | t test | Ctrl+s save | Esc cancel");
    if (this.notice) rows.push("", theme.fg("warning", this.notice));
    return rows.flatMap(wrap).map((line) => truncateToWidth(line, width, ""));
  }
  invalidate(): void { this.reference.invalidate(); this.secret.invalidate(); }
  dispose(): void { this.closed = true; this.secret.dispose(); this.reference = new Input(); }
}
