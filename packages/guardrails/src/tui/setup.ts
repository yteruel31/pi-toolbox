import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, SettingsList, fuzzyFilter, matchesKey, wrapTextWithAnsi, type Component, type SettingItem } from "@earendil-works/pi-tui";
import { SecretInput } from "./secret-input.js";
import type { Config } from "../config.js";
import { judgeChoices, judgeThinking, selectedJudge, type JudgeCatalog, type ModelChoice } from "../model-catalog.js";
import { sanitize } from "../sanitize.js";

interface SetupState { setupIndex?: number; notice?: string }
interface Options {
  draft: Config; state: SetupState; theme: Theme; keybindings: KeybindingsManager;
  catalog: () => JudgeCatalog; save: () => void;
  defaultJevFile?: string; stageJevKey?: (value: string | undefined) => void;
}
const labels = { bash: "Bash", read: "Read", write: "Write", edit: "Edit", mcp: "MCP", "web-access": "Web access" };
const onOff = (value: boolean) => value ? "On" : "Off";

/** Native settings and submenus stay mounted, so cancel restores their original row. */
export class SetupSettings implements Component {
  private list!: SettingsList;
  private items: SettingItem[] = [];
  private visible = 0;
  private picker?: Component;
  private closePicker?: () => void;
  private catalog?: JudgeCatalog;
  private budget = 10;
  private secret = new SecretInput();
  private jevReferences: Record<"environment" | "file", string>;
  focused = false;
  constructor(private o: Options) {
    this.jevReferences = {
      environment: o.draft.jev.credential.source === "environment" ? o.draft.jev.credential.reference : "TYPESAFE_API_KEY",
      file: o.draft.jev.credential.source === "file" ? o.draft.jev.credential.reference : (o.defaultJevFile ?? "/tmp/pi-guardrails-jev.credentials.json"),
    };
    this.build(3);
  }
  get inSubmenu(): boolean { return !!this.picker; }
  cancelSubmenu(): void { this.closePicker?.(); }
  private getCatalog(): JudgeCatalog {
    // Rule-only Setup must not even access the registry.
    if (!this.o.draft.judgeEnabled || this.o.draft.backend !== "pi") return { models: [] };
    return this.catalog ??= this.o.catalog();
  }
  private submenu(choices: ModelChoice[], value: string, done: (value?: string) => void, message: string): Component {
    const finish = (next?: string) => { this.picker = undefined; this.closePicker = undefined; done(next); };
    this.closePicker = () => finish();
    return this.picker = new SearchPicker(choices, value, this.o.theme, this.o.keybindings, finish, message, () => this.budget);
  }
  private build(visible: number): void {
    const { draft, theme } = this.o;
    this.visible = visible;
    this.items = [
      { id: "enabled", label: "Protection", currentValue: onOff(draft.enabled), values: ["Off", "On"], description: "Off bypasses all guardrails. Coverage settings are retained." },
      ...Object.entries(labels).map(([id, label]) => ({ id, label, currentValue: onOff(draft.coverage[id as keyof Config["coverage"]]), values: ["Off", "On"], description: `${id === "mcp" || id === "web-access" ? "Main only; native confirmations still apply." : "Main and Pi workers."} Off: no guardrails assessment, prompt or history.` })),
      { id: "judgeEnabled", label: "Judge model", currentValue: onOff(draft.judgeEnabled), values: ["Off", "On"], description: "Off: deterministic rules only. No match ALLOWS main and workers. Natural-language policies are inactive." },
      { id: "backend", label: "Judge backend", currentValue: draft.backend, values: ["pi", "jev"], description: "Pi is the default. Jev uses its independent credential and fixed jev-latest model." },
      { id: "credentialSource", label: "Jev credential", currentValue: draft.jev.credential.source, values: ["environment", "keyring", "file"], description: "Environment is read at assessment time. Keyring requires libsecret-tools, session D-Bus, and an unlocked collection. Private files must be owner-only outside repositories." },
      { id: "credentialReference", label: "Jev reference", currentValue: draft.jev.credential.reference, submenu: (_value, done) => {
        if (draft.jev.credential.source === "keyring") return this.textEditor("Keyring reference is fixed to pi-guardrails/jev.", draft.jev.credential.reference, done, true);
        return this.textEditor(draft.jev.credential.source === "environment" ? "Enter an environment variable name." : "Enter an absolute private-file path outside repositories.", draft.jev.credential.reference, done);
      }, description: "Environment variable, fixed pi-guardrails/jev keyring identity, or absolute private-file path." },
      { id: "jevKey", label: "Jev API key", currentValue: "not staged", submenu: (_value, done) => draft.jev.credential.source === "environment"
        ? this.textEditor("Environment credentials are reference-only and are read at assessment time.", "", done, true)
        : this.secretEditor(done), description: "For file or keyring storage, enter a masked key. It stays in memory and is persisted only by the main confirmed Save. Environment credentials are reference-only." },
      { id: "allowThreshold", label: "Jev Allow threshold", currentValue: String(draft.jev.allowThreshold), values: ["0.9", "0.95", "0.99"] },
      { id: "denyThreshold", label: "Jev Deny threshold", currentValue: String(draft.jev.denyThreshold), values: ["0.7", "0.8", "0.9", "0.95"] },
      { id: "model", label: "Model", currentValue: "", submenu: (_value, done) => {
        const enabled = draft.judgeEnabled && draft.backend === "pi";
        return this.submenu(enabled ? judgeChoices(this.getCatalog(), draft.model) : [], draft.model, done,
          enabled ? "Choose judge model. Parent model stays unchanged." : "Judge model is off. Saved route retained; enable it to choose.");
      } },
      { id: "thinking", label: "Judge thinking", currentValue: draft.thinking, submenu: (_value, done) => {
        const levels = draft.judgeEnabled && draft.backend === "pi" ? judgeThinking(this.getCatalog(), draft) : [];
        return this.submenu(levels.map((value) => ({ value, label: value })), draft.thinking, done,
          !draft.judgeEnabled ? "Judge model is off. Saved thinking retained." : !levels.length ? "Model unavailable. Select an available model first." : levels.includes(draft.thinking) ? "Independent of parent thinking. Choose explicitly." : `Saved ${draft.thinking} is incompatible. Retained until you explicitly choose a supported level.`);
      } },
      { id: "errorBehavior", label: "On error", currentValue: draft.errorBehavior, values: ["ask", "deny"], description: "Errors never allow silently. Worker Ask blocks without a popup." },
      { id: "timeoutMs", label: "Timeout (ms)", currentValue: String(draft.timeoutMs), values: ["5000", "15000", "30000", "60000"] },
      { id: "maxOutputTokens", label: "Output tokens", currentValue: String(draft.maxOutputTokens), values: ["512", "1024", "2048", "4096"] },
      { id: "save", label: "Save", currentValue: "Enter / Ctrl+s", values: ["Enter / Ctrl+s"] },
    ];
    this.list = new SettingsList(this.items, visible, {
      label: (t, selected) => theme.fg(selected ? "accent" : "text", t), value: (t) => theme.fg("muted", t),
      description: (t) => theme.fg("muted", t), cursor: theme.fg("accent", "▸ "), hint: (t) => theme.fg("dim", t),
    }, (id, value) => {
      if (id === "save") { this.o.save(); return; }
      if (id === "enabled" || id === "judgeEnabled") draft[id] = value === "On";
      else if (id in labels) draft.coverage[id as keyof Config["coverage"]] = value === "On";
      else if (id === "backend") { draft.backend = value as Config["backend"]; this.catalog = undefined; }
      else if (id === "credentialSource") {
        const old = draft.jev.credential.source;
        if (old === "environment" || old === "file") this.jevReferences[old] = draft.jev.credential.reference;
        draft.jev.credential.source = value as Config["jev"]["credential"]["source"];
        draft.jev.credential.reference = value === "keyring" ? "pi-guardrails/jev" : this.jevReferences[value as "environment" | "file"];
        this.secret.clear(); this.o.stageJevKey?.(undefined);
      }
      else if (id === "credentialReference") {
        draft.jev.credential.reference = value;
        if (draft.jev.credential.source === "environment" || draft.jev.credential.source === "file") this.jevReferences[draft.jev.credential.source] = value;
        this.secret.clear(); this.o.stageJevKey?.(undefined);
      }
      else if (id === "jevKey") { /* committed by the masked editor */ }
      else if (id === "allowThreshold" || id === "denyThreshold") draft.jev[id] = Number(value);
      else if (id === "model") draft.model = value;
      else if (id === "thinking") draft.thinking = value as Config["thinking"];
      else if (id === "errorBehavior") draft.errorBehavior = value as Config["errorBehavior"];
      else if (id === "timeoutMs" || id === "maxOutputTokens") draft[id] = Number(value);
      if (id === "judgeEnabled") this.catalog = undefined;
      this.refresh();
    }, () => {});
    for (let i = 0; i < (this.o.state.setupIndex ?? 0); i++) this.list.handleInput("\x1b[B");
    this.refresh();
  }
  private refresh(): void {
    const { draft } = this.o;
    const model = this.items.find((item) => item.id === "model")!;
    const thinking = this.items.find((item) => item.id === "thinking")!;
    const reference = this.items.find((item) => item.id === "credentialReference")!;
    const key = this.items.find((item) => item.id === "jevKey")!;
    reference.currentValue = sanitize(draft.jev.credential.reference, 200);
    key.currentValue = draft.jev.credential.source === "environment" ? "reference only" : this.secret.getValue() ? "staged (masked)" : "not staged";
    model.currentValue = sanitize(draft.model || "Follow parent", 200);
    thinking.currentValue = draft.thinking;
    if (!draft.judgeEnabled || draft.backend === "jev") {
      model.description = draft.judgeEnabled ? "Inactive for Jev. Saved Pi route retained." : "Inactive: judge model is off. Saved route retained.";
      thinking.description = draft.judgeEnabled ? "Inactive for Jev. Saved Pi thinking retained." : "Inactive: judge model is off. Saved thinking retained.";
      return;
    }
    try {
      const catalog = this.getCatalog();
      const selected = selectedJudge(catalog, draft.model);
      model.description = selected ? `Judge: ${sanitize(`${selected.provider}/${selected.id}`, 220)}. Parent unchanged.` : "Saved/followed model unavailable or outside scope. Route retained; choose explicitly.";
      const compatible = judgeThinking(catalog, draft).includes(draft.thinking);
      thinking.description = compatible ? "Independent of parent thinking; defaults to off." : `Saved ${draft.thinking} is incompatible or model unavailable. Retained; select a supported level. Until then, model evaluation fails closed.`;
      if (selected && !compatible) model.description = `Thinking ${draft.thinking} is incompatible. Choose Judge thinking explicitly; saved value retained. ${model.description}`;
    } catch {
      this.catalog = { models: [] };
      model.description = "Model catalog unavailable. Saved route retained.";
      thinking.description = "Catalog unavailable. Saved thinking retained.";
    }
  }
  handleInput(data: string): void {
    if (!this.picker) {
      const up = this.o.keybindings.matches(data, "tui.select.up") || matchesKey(data, "up");
      const down = this.o.keybindings.matches(data, "tui.select.down") || matchesKey(data, "down");
      if (up || down) this.o.state.setupIndex = ((this.o.state.setupIndex ?? 0) + (up ? -1 : 1) + this.items.length) % this.items.length;
    }
    this.list.handleInput(data);
  }
  render(width: number, rows = 12): string[] {
    this.budget = rows;
    const visible = Math.max(1, Math.min(this.items.length, rows - 7));
    if (visible !== this.visible && !this.picker) this.build(visible);
    if (this.picker && "focused" in this.picker) (this.picker as Component & { focused: boolean }).focused = this.focused;
    return this.list.render(width);
  }
  private textEditor(message: string, value: string, done: (value?: string) => void, readonly = false): Component {
    const input = new Input(); input.setValue(value);
    const finish = (next?: string) => { this.picker = undefined; this.closePicker = undefined; done(next); };
    const editor: Component & { focused: boolean } = {
      focused: false,
      handleInput: (data: string) => {
        input.handleInput(data);
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) finish();
        else if (matchesKey(data, "enter")) finish(readonly ? undefined : input.getValue());
      },
      render: (width: number) => [...wrapTextWithAnsi(this.o.theme.fg("muted", message), width), ...(readonly ? [] : (input.focused = editor.focused, input.render(width)))],
      invalidate: () => input.invalidate(),
    };
    this.closePicker = () => finish(); return this.picker = editor;
  }
  private secretEditor(done: (value?: string) => void): Component {
    this.secret.clear();
    const finish = (commit: boolean) => {
      const value = this.secret.getValue(); this.picker = undefined; this.closePicker = undefined;
      if (commit && value && !this.secret.invalid) this.o.stageJevKey?.(value); else this.secret.clear();
      done(commit && value && !this.secret.invalid ? "staged (masked)" : undefined); this.refresh();
    };
    const editor: Component & { focused: boolean } = {
      focused: false,
      handleInput: (data: string) => { if (this.secret.consumePaste(data)) return; if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) finish(false); else if (matchesKey(data, "enter")) finish(true); else this.secret.handleInput(data); },
      render: (width: number) => [...wrapTextWithAnsi(this.o.theme.fg("muted", "Enter API key (masked). Enter stages it; Escape cancels. Main Save persists it."), width), ...(this.secret.focused = editor.focused, this.secret.render(width))],
      invalidate: () => this.secret.invalidate(),
    };
    this.closePicker = () => finish(false); return this.picker = editor;
  }
  invalidate(): void { this.list.invalidate(); this.secret.invalidate(); }
  dispose(): void { this.secret.dispose(); }
}

/** Search is data; only native selection keys commit a choice. */
export class SearchPicker implements Component {
  private input = new Input();
  private list!: SelectList;
  private filtered: ModelChoice[] = [];
  focused = false;
  private visible = 0;
  constructor(private choices: ModelChoice[], private selected: string, private theme: Theme, private kb: KeybindingsManager,
    private done: (value?: string) => void, private message: string, private rows: () => number) { this.filter(); }
  private filter(): void {
    this.filtered = fuzzyFilter(this.choices, this.input.getValue(), (item) => `${item.label} ${item.description ?? ""}`);
    this.list = new SelectList(this.filtered.map((item) => ({ ...item, label: sanitize(item.label, 220), description: sanitize(item.description ?? "", 250) })), Math.max(1, this.visible), {
      selectedPrefix: (t) => this.theme.fg("accent", t), selectedText: (t) => this.theme.fg("accent", t),
      description: (t) => this.theme.fg("muted", t), scrollInfo: (t) => this.theme.fg("dim", t), noMatch: (t) => this.theme.fg("warning", t),
    });
    this.list.setSelectedIndex(Math.max(0, this.filtered.findIndex((item) => item.value === this.selected)));
    this.list.onSelect = (item) => { if (!this.filtered.find((choice) => choice.value === item.value)?.unavailable) this.done(item.value); };
    this.list.onCancel = () => this.done();
  }
  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { this.done(); return; }
    if (["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.pageUp", "tui.select.pageDown"].some((key) => this.kb.matches(data, key as Parameters<KeybindingsManager["matches"]>[1]))) {
      this.list.handleInput(data);
      this.selected = this.list.getSelectedItem()?.value ?? this.selected;
    } else { this.input.handleInput(data); this.filter(); }
  }
  render(width: number): string[] {
    const message = wrapTextWithAnsi(this.theme.fg("muted", this.message), width).slice(0, Math.max(1, Math.min(3, this.rows() - 4)));
    const visible = Math.max(1, this.rows() - message.length - 3);
    if (visible !== this.visible) { this.visible = visible; this.filter(); }
    this.input.focused = this.focused;
    return [...message, ...this.input.render(width), ...this.list.render(width)];
  }
  invalidate(): void { this.input.invalidate(); this.list.invalidate(); }
}
