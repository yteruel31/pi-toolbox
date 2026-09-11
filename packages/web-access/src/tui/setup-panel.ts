import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Focusable, type OverlayOptions } from "@earendil-works/pi-tui";
import { SetupError, setupErrorMessage, validModel, type Provider, type SetupDraft, type SetupSnapshot, type Storage } from "../setup-store.js";
import { SecretInput } from "./secret-input.js";

export const SETUP_OVERLAY: OverlayOptions = { width: 72, minWidth: 32, maxHeight: "85%", anchor: "center", margin: 1 };
export function setupRows(terminalRows: number): number { return Math.max(1, Math.min(22, Math.floor(terminalRows * 0.85) - 2)); }
type Step = "provider" | "enabled" | "search" | "research" | "synthesis" | "storage" | "key" | "review";
interface Options {
  theme: Theme;
  keybindings: KeybindingsManager;
  snapshot: SetupSnapshot;
  maxRows: () => number;
  onRender: () => void;
  onDone: (saved: boolean) => void;
  onSave: (draft: SetupDraft, key?: string) => Promise<void>;
}
const providers: Provider[] = ["gemini", "openai", "brave"];
const stores: Storage[] = ["keep", "file", "keyring"];
const titles: Record<Step, string> = {
  provider: "Search provider", enabled: "Web access tools", search: "Native search model", research: "Native deep research model",
  synthesis: "Pi synthesis model", storage: "Credential storage", key: "API key", review: "Review changes",
};
function safeText(text: string): string { return text.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " "); }
function sourceLabel(source: string): string {
  if (source.startsWith("file:")) return "private file reference";
  if (source.startsWith("keyring:")) return "Linux keyring reference";
  if (source.startsWith("$")) return "environment reference";
  return "existing literal (hidden)";
}

/** A staged, package-local wizard in the same centered frame as /mcp. */
export class SetupPanel implements Component, Focusable {
  #options: Options;
  #draft: SetupDraft;
  #secret = new SecretInput();
  #input = new Input();
  private step: Step = "provider";
  private selected = 0;
  private scroll = 0;
  private manualScroll = false;
  #modelPaste: string | undefined;
  private closed = false;
  private busy = false;
  private tooSmall = false;
  private notice?: string;
  private failure?: "storage" | "close";
  focused = false;

  constructor(options: Options) {
    this.#options = options;
    const config = options.snapshot.config;
    this.#draft = { provider: config.search.provider ?? "gemini", enabled: config.enabled, synthesisModel: config.synthesisModel, storage: "keep" };
    this.setProvider(this.#draft.provider);
    this.enter("provider");
  }
  private setProvider(provider: Provider): void {
    this.#draft.provider = provider;
    this.#secret.clear();
    const field = provider === "gemini" ? "geminiModel" : "openaiModel";
    this.#draft.searchModel = provider === "brave" ? undefined : this.#options.snapshot.config.search[field];
    this.#draft.researchModel = provider === "brave" ? undefined : this.#options.snapshot.config.research[field];
  }
  private steps(): Step[] {
    return ["provider", "enabled", ...(this.#draft.provider === "brave" ? [] : ["search", "research"] as Step[]), "synthesis", "storage", ...(this.#draft.storage === "keep" ? [] : ["key"] as Step[]), "review"];
  }
  private enter(step: Step): void {
    this.step = step; this.scroll = 0; this.manualScroll = false; this.notice = undefined;
    this.#modelPaste = undefined;
    if (step === "provider") this.selected = providers.indexOf(this.#draft.provider);
    else if (step === "enabled") this.selected = this.#draft.enabled ? 0 : 1;
    else if (step === "storage") this.selected = stores.indexOf(this.#draft.storage);
    else this.selected = 0;
    this.#input = new Input();
    if (step === "search") this.#input.setValue(safeText(this.#draft.searchModel ?? ""));
    if (step === "research") this.#input.setValue(safeText(this.#draft.researchModel ?? ""));
    if (step === "synthesis") this.#input.setValue(safeText(this.#draft.synthesisModel ?? ""));
  }
  private redraw(): void { if (!this.closed) this.#options.onRender(); }
  private finish(saved: boolean): void {
    if (this.closed) return;
    this.dispose(); this.#options.onDone(saved);
  }
  dispose(): void { this.closed = true; this.#secret.dispose(); this.#input = new Input(); this.#modelPaste = undefined; }
  private back(): void {
    const steps = this.steps();
    this.enter(steps[Math.max(0, steps.indexOf(this.step) - 1)]!);
  }
  private isText(): boolean { return ["search", "research", "synthesis"].includes(this.step); }
  private next(): void {
    if (this.step === "provider") {
      const selected = providers[this.selected]!;
      if (selected !== this.#draft.provider) this.setProvider(selected);
    } else if (this.step === "enabled") this.#draft.enabled = this.selected === 0;
    else if (this.step === "storage") {
      this.#draft.storage = stores[this.selected]!;
      if (this.#draft.storage === "keep") this.#secret.clear();
    } else if (this.isText()) {
      const edited = this.#input.getValue();
      const initial = (this.step === "search" ? this.#draft.searchModel : this.step === "research" ? this.#draft.researchModel : this.#draft.synthesisModel) ?? "";
      const value = edited === safeText(initial) ? initial : edited;
      if (value !== initial && !(this.step === "synthesis" && !value) && !validModel(value, this.step === "synthesis")) {
        this.notice = this.step === "synthesis" ? "Use provider/model-id, or leave blank for the current Pi model." : "Use a model ID (up to 200 characters, no spaces).";
        return;
      }
      if (this.step === "search") this.#draft.searchModel = value;
      else if (this.step === "research") this.#draft.researchModel = value;
      else this.#draft.synthesisModel = value || undefined;
    } else if (this.step === "key" && (!this.#secret.getValue() || this.#secret.invalid)) {
      this.notice = "Enter a non-empty API key without whitespace. Ctrl+u clears the field.";
      return;
    }
    const steps = this.steps();
    this.enter(steps[Math.min(steps.length - 1, steps.indexOf(this.step) + 1)]!);
  }
  private async save(): Promise<void> {
    this.busy = true; this.notice = undefined; this.redraw();
    try {
      await this.#options.onSave({ ...this.#draft }, this.#draft.storage === "keep" ? undefined : this.#secret.getValue());
      this.finish(true);
    } catch (error) {
      this.notice = setupErrorMessage(error);
      this.failure = error instanceof SetupError && error.code === "keyring" ? "storage" : "close";
      this.scroll = 0;
    } finally { this.busy = false; this.redraw(); }
  }
  handleInput(data: string): void {
    if (this.closed || this.busy) return;
    // Never interpret pasted newlines or escape sequences as navigation or confirmation.
    if (this.step === "key" && this.#secret.consumePaste(data)) { this.redraw(); return; }
    if (this.isText() && (this.#modelPaste !== undefined || data.startsWith("\x1b[200~"))) {
      const combined = (this.#modelPaste ?? "") + (this.#modelPaste === undefined ? data.slice(6) : data);
      if (combined.includes("\x1b[201~")) {
        const text = combined.slice(0, combined.indexOf("\x1b[201~"));
        if (text.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(text)) this.#input.handleInput(`\x1b[200~${text}\x1b[201~`);
        else this.notice = "Paste rejected: use a single-line model ID.";
        this.#modelPaste = undefined;
      } else {
        // Keep an invalid sentinel when over budget, plus the delimiter tail, until paste ends.
        this.#modelPaste = combined.length > 4102 ? "\x00" + combined.slice(-5) : combined;
      }
      this.redraw(); return;
    }
    const kb = this.#options.keybindings;
    if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.finish(false); return; }
    if (this.tooSmall) return;
    if (matchesKey(data, "pageDown") || matchesKey(data, "pageUp")) {
      this.manualScroll = true;
      this.scroll = Math.max(0, this.scroll + (matchesKey(data, "pageDown") ? 1 : -1));
      this.redraw(); return;
    }
    const confirm = kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter");
    if (this.failure) {
      if (confirm) {
        if (this.failure === "close") { this.finish(false); return; }
        this.failure = undefined; this.enter("storage");
      } else if (matchesKey(data, "down")) this.scroll++;
      else if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
      this.redraw(); return;
    }
    if (matchesKey(data, "shift+tab") || matchesKey(data, "alt+left")) this.back();
    else if (this.step === "review") {
      if (confirm || matchesKey(data, "ctrl+s")) { void this.save(); return; }
      if (matchesKey(data, "down") || matchesKey(data, "pageDown")) this.scroll++;
      else if (matchesKey(data, "up") || matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 1);
    } else if (confirm) this.next();
    else if (this.step === "key") {
      this.#secret.handleInput(data);
      this.notice = this.#secret.invalid ? "Key not accepted: use printable characters without spaces (max 16384). Ctrl+u clears." : undefined;
    } else if (this.isText()) {
      // Native Input handles cursor movement and bracketed paste; these fields never receive credentials.
      if (matchesKey(data, "ctrl+u")) this.#input.setValue("");
      else this.#input.handleInput(data);
      if (this.#input.getValue().length > 4096) { this.#input.setValue(this.#input.getValue().slice(0, 4096)); this.notice = "Model ID is too long."; }
    } else {
      this.manualScroll = false;
      const length = this.step === "enabled" ? 2 : 3;
      if (kb.matches(data, "tui.select.down") || matchesKey(data, "down") || matchesKey(data, "tab")) this.selected = (this.selected + 1) % length;
      else if (kb.matches(data, "tui.select.up") || matchesKey(data, "up")) this.selected = (this.selected + length - 1) % length;
    }
    this.redraw();
  }
  private body(width: number): string[] {
    const theme = this.#options.theme;
    const wrap = (value: string) => wrapTextWithAnsi(value, width);
    if (this.failure) return wrap(theme.fg("error", this.notice!));
    const { provider, storage } = this.#draft;
    const lines: string[] = [];
    const menu = (labels: string[]) => labels.forEach((label, index) => {
      const selected = this.selected === index;
      const line = `${selected ? "▸" : " "} ${label}`;
      lines.push(selected ? theme.bg("selectedBg", theme.fg("accent", line)) : line);
    });
    if (this.step === "provider") {
      lines.push(...wrap("Choose the default for web_search and source_check."), "");
      menu(["Gemini", "OpenAI", "Brave"]);
      lines.push("", ...wrap("API-key billing, not consumer subscriptions. Deep research always requires an explicit Gemini or OpenAI provider."));
    } else if (this.step === "enabled") {
      menu(["Enabled", "Disabled"]);
      lines.push("", ...wrap("Controls this package's five tools after /reload. Other Pi extensions are unchanged."));
    } else if (this.isText()) {
      const hint = this.step === "search" ? `Used by ${provider} native search. Requests use the provider API key.`
        : this.step === "research" ? `Default for ${provider} deep_research. Separate from search; no job is started here.`
        : "Optional provider/model-id from Pi. Blank uses the current Pi model. Uses Pi authentication and its session model allowlist, not this API key.";
      lines.push(...wrap(hint), "");
      this.#input.focused = this.focused;
      lines.push(...this.#input.render(width), "");
      if (provider === "brave") lines.push(...wrap("Brave has no native search or research model. This only configures optional Pi synthesis."));
    } else if (this.step === "storage") {
      menu(["Keep current source", "Private file (0600)", "Linux Secret Service keyring"]);
      lines.push("", ...wrap(`Current: ${sourceLabel(this.#options.snapshot.config.credentials[provider])}. Not checked or displayed.`));
      const help = this.selected === 0 ? "No key read, copy or migration. Keep environment/literal/keyring/file configuration unchanged."
        : this.selected === 1 ? "Plaintext in the Pi agent directory, protected by permissions, not encrypted. Root and processes running as you can read it."
        : "Requires Linux, libsecret-tools, session D-Bus and an unlocked Secret Service collection. No automatic fallback to a file.";
      lines.push("", ...wrap(help));
    } else if (this.step === "key") {
      lines.push(...wrap(`Enter the ${provider} API key for ${storage === "file" ? "private file storage" : "Linux Secret Service"}.`), "");
      this.#secret.focused = this.focused;
      lines.push(...this.#secret.render(width), "", ...wrap("Input stays masked. Never paste a key into chat or command arguments. Nothing is saved yet."));
    } else {
      lines.push(`Tools: ${this.#draft.enabled ? "enabled" : "disabled"}`, `Default search: ${provider}`);
      if (provider !== "brave") lines.push(`Search model: ${safeText(this.#draft.searchModel!)}`, `Research model: ${safeText(this.#draft.researchModel!)}`);
      else lines.push("Brave: no native model settings");
      lines.push(`Pi synthesis: ${safeText(this.#draft.synthesisModel ?? "current Pi model")}`,
        `Credentials: ${storage === "keep" ? "keep current source (not checked)" : storage === "file" ? "private file (0600)" : "Linux Secret Service"}`,
        `API key: ${storage === "keep" ? "unchanged" : "entered (hidden); replaces this provider's stored key"}`, "",
        "Unrelated settings and other providers' keys are preserved. Old credential sources are not deleted when switching storage.",
        "Save does not test the key or call a paid API. If storing the key succeeds but saving settings fails, the key can remain stored; the error will say so.");
      return lines.flatMap(wrap);
    }
    if (this.notice) lines.push("", ...wrap(theme.fg("warning", this.notice)));
    return lines;
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const rows = Math.max(1, this.#options.maxRows());
    const theme = this.#options.theme;
    this.tooSmall = width < 32 || rows < 12;
    if (this.tooSmall) return ["Web access: resize terminal", "Minimum panel: 32 x 12", "Esc cancel"].slice(0, rows).map((line) => truncateToWidth(line, width, ""));
    const inner = width - 4;
    const steps = this.steps();
    const title = ` Web access ${steps.indexOf(this.step) + 1}/${steps.length} `;
    const footer = this.busy ? ["Saving locally. Please wait..."] : this.failure ?
      [this.failure === "storage" ? "Enter choose storage again" : "Enter close; reopen setup to retry", "Up/Down scroll | Esc close"] :
      [this.step === "review" ? "Enter save changes | Up/Down scroll" : this.isText() || this.step === "key" ? "Enter next | Ctrl+u clear" : "Up/Down select | Enter next",
        "Shift+Tab back | Esc cancel", "PgUp/PgDn scroll"];
    const wrappedFooter = footer.flatMap((line) => wrapTextWithAnsi(line, inner));
    const body = this.body(inner);
    const budget = Math.max(1, rows - wrappedFooter.length - 5);
    // Form fields and selected rows must remain visible even when explanatory copy wraps.
    if (this.step !== "review" && !this.failure && !this.manualScroll) {
      const focus = this.isText() || this.step === "key" ? body.findIndex((line) => line.includes("\x1b[7m"))
        : body.findIndex((line) => line.includes("▸"));
      this.scroll = Math.max(0, focus >= budget ? focus - budget + 1 : 0);
      if (this.notice) this.scroll = Math.max(this.scroll, body.length - budget);
    }
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - budget));
    const content = body.slice(this.scroll, this.scroll + budget);
    const clipped = (line: string, size: number) => truncateToWidth(line, size, "");
    const row = (line: string) => {
      const text = clipped(line, inner);
      return theme.fg("borderMuted", "│ ") + text + " ".repeat(Math.max(0, inner - visibleWidth(text))) + theme.fg("borderMuted", " │");
    };
    const heading = theme.fg("accent", theme.bold(clipped(title, width - 2)));
    const progress = body.length > budget ? ` (${this.scroll + 1}-${this.scroll + content.length}/${body.length})` : "";
    return [
      theme.fg("borderAccent", "╭") + heading + theme.fg("borderAccent", "─".repeat(Math.max(0, width - visibleWidth(heading) - 2)) + "╮"),
      row(theme.bold(titles[this.step]) + theme.fg("dim", progress)),
      ...content.map(row),
      theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`),
      ...wrappedFooter.map((line) => row(theme.fg("dim", line))),
      theme.fg("borderAccent", `╰${"─".repeat(width - 2)}╯`),
    ];
  }
  invalidate(): void { this.#input.invalidate(); this.#secret.invalidate(); }
}
