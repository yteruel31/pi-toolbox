import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CombinedAutocompleteProvider,
  Editor,
  type Component,
  type Focusable,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { type AskConfig, bindingMatches, ConfigStore } from "./config.ts";
import type { AskForm, AskResult, AskSource } from "./contracts.ts";
import {
  activeQuestion,
  allAnswered,
  buildResult,
  cancelledResult,
  clearTypeConfirmation,
  createAskState,
  draftFor,
  hasAnyNotes,
  isAnswered,
  moveCursor,
  moveTab,
  presentedType,
  requestDismiss,
  requestTypeToggle,
  selectDeclared,
  setCustomText,
  setOptionNote,
  setQuestionNote,
  toggleCustom,
  type AskState,
} from "./domain.ts";
import { notifyWaiting } from "./notifications.ts";
import { editorBindingHint, inlineEditorWidth, SETTINGS_ROWS, renderAsk, type AskRenderView } from "./render.ts";
import type { RemoteAskRegistry } from "./remote.ts";

export type InputContext = "global" | "main" | "editor" | "noteEditor" | "settingsModal";

export function resolveConfiguredAction(
  data: string,
  context: InputContext,
  config: AskConfig,
  match: (data: string, key: string) => boolean = (input, key) => matchesKey(input, key as never),
): string | undefined {
  const maps: Array<Record<string, string[]>> = [];
  if (context === "global") maps.push(config.keymaps.global);
  else {
    if (context !== "settingsModal") maps.push(config.keymaps.global);
    maps.push(config.keymaps[context] as Record<string, string[]>);
  }
  for (const map of maps) {
    for (const [action, bindings] of Object.entries(map)) {
      if (bindingMatches(data, bindings, match)) return action;
    }
  }
  return undefined;
}

type EditMode = "main" | "custom" | "question-note" | "option-note" | "settings";

export class AskComponent implements Component, Focusable {
  readonly state: AskState;
  private config: AskConfig;
  private mode: EditMode = "main";
  private modeBeforeSettings: EditMode = "main";
  private editor: Editor;
  private editorTargetValue?: string;
  private warning?: string;
  private settingsCursor = 0;
  private settingsMessage?: string;
  private resetArmedUntil = 0;
  private unsubscribe: () => void;
  private completed = false;
  private _focused = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly cwd: string;
  private readonly store: ConfigStore;
  private readonly finish: (result: AskResult) => void;
  private readonly notify: (message: string, type?: "info" | "warning" | "error") => void;
  private readonly settingsOnly: boolean;

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.isEditing();
  }

  constructor(
    tui: TUI,
    theme: Theme,
    form: AskForm,
    cwd: string,
    store: ConfigStore,
    finish: (result: AskResult) => void,
    notify: (message: string, type?: "info" | "warning" | "error") => void,
    settingsOnly = false,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.cwd = cwd;
    this.store = store;
    this.finish = finish;
    this.notify = notify;
    this.settingsOnly = settingsOnly;
    this.state = createAskState(form);
    this.config = store.get();
    this.editor = new Editor(tui, {
      borderColor: (text) => theme.fg("borderAccent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    }, { paddingX: 0, autocompleteMaxVisible: 8 });
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(undefined, cwd));
    this.editor.disableSubmit = true;
    this.editor.onChange = () => this.refresh();
    this.editor.onSubmit = undefined;
    if (settingsOnly) this.mode = "settings";
    else this.maybeOpenFreeform();
    this.unsubscribe = store.subscribe((config) => {
      this.config = config;
      if (config.behaviour.autoSubmitWhenAnsweredWithoutNotes && this.onReview() && allAnswered(this.state) && !hasAnyNotes(this.state)) {
        this.complete(buildResult(this.state, "submit"));
      } else this.refresh();
    });
  }

  get settled(): boolean { return this.completed; }

  settle(result: AskResult): void { this.complete(result); }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribe = () => {};
    this.editor.onChange = undefined;
    this.editor.onSubmit = undefined;
  }
  invalidate(): void { this.editor.invalidate(); }

  private refresh(): void {
    this.editor.focused = this.focused && this.isEditing();
    this.tui.requestRender();
  }

  private complete(result: AskResult): void {
    if (this.completed) return;
    this.completed = true;
    this.dispose();
    this.finish(result);
  }

  private onReview(): boolean { return this.state.tab === this.state.form.questions.length; }
  private isEditing(): boolean { return this.mode === "custom" || this.mode === "question-note" || this.mode === "option-note"; }

  private currentEditorText(): string { return this.isEditing() ? this.editor.getExpandedText() : ""; }

  private maybeOpenFreeform(): void {
    const question = activeQuestion(this.state);
    if (question?.freeform) this.startEditor("custom", draftFor(this.state, question.id).customText ?? "");
  }

  private startEditor(mode: Exclude<EditMode, "main" | "settings">, text: string, optionValue?: string): void {
    this.mode = mode;
    this.editorTargetValue = optionValue;
    this.editor.setText(text);
    this.editor.focused = this.focused;
    this.refresh();
  }

  private closeEditor(): void {
    this.mode = "main";
    this.editorTargetValue = undefined;
    this.editor.setText("");
    this.refresh();
  }

  private commitEditor(): void {
    const question = activeQuestion(this.state);
    if (!question) return;
    const text = this.editor.getExpandedText();
    if (this.mode === "custom") setCustomText(this.state, question, text);
    else if (this.mode === "question-note") setQuestionNote(this.state, question.id, text);
    else if (this.mode === "option-note" && this.editorTargetValue) setOptionNote(this.state, question.id, this.editorTargetValue, text);
    this.closeEditor();
  }

  private navigateTabs(delta: number): void {
    if (this.isEditing()) this.closeEditor();
    moveTab(this.state, delta);
    this.warning = undefined;
    this.maybeOpenFreeform();
    this.maybeAutoSubmit();
    this.refresh();
  }

  private maybeAutoSubmit(): void {
    if (this.config.behaviour.autoSubmitWhenAnsweredWithoutNotes && this.onReview() && allAnswered(this.state) && !hasAnyNotes(this.state)) {
      this.complete(buildResult(this.state, "submit"));
    }
  }

  private attemptCancel(action: "dismiss" | "cancel"): void {
    if (requestDismiss(this.state, action, this.config.behaviour.confirmDismissWhenDirty, this.currentEditorText())) {
      this.complete(cancelledResult(this.state.form));
    } else {
      this.warning = `Unsaved answers will be discarded. Press ${action === "dismiss" ? "dismiss" : "cancel"} again.`;
      this.refresh();
    }
  }

  private openSettings(): void {
    clearTypeConfirmation(this.state);
    this.modeBeforeSettings = this.mode;
    this.mode = "settings";
    this.settingsMessage = undefined;
    this.refresh();
  }

  private closeSettings(): void {
    if (this.settingsOnly) {
      this.complete(cancelledResult(this.state.form, "Ask settings closed."));
      return;
    }
    this.mode = this.modeBeforeSettings;
    this.refresh();
  }

  private async toggleSetting(): Promise<void> {
    const row = SETTINGS_ROWS[this.settingsCursor];
    if (!row) return;
    const [key] = row;
    if (key === "reset") {
      const now = Date.now();
      if (now > this.resetArmedUntil) {
        this.resetArmedUntil = now + 2_000;
        this.settingsMessage = "Press the reset action again within 2 seconds.";
        this.refresh();
        return;
      }
      this.resetArmedUntil = 0;
      const result = await this.store.reset();
      this.settingsMessage = result.ok ? "Configuration reset." : result.message;
      this.notify(this.settingsMessage, result.ok ? "info" : "error");
      this.refresh();
      return;
    }
    const result = await this.store.update((config) => {
      if (key === "notifications.enabled") config.notifications.enabled = !config.notifications.enabled;
      else {
        const behaviourKey = key as keyof AskConfig["behaviour"];
        config.behaviour[behaviourKey] = !config.behaviour[behaviourKey];
      }
    });
    this.settingsMessage = result.ok ? "Saved." : result.message;
    if (!result.ok) this.notify(result.message, "error");
    this.refresh();
  }

  private handleSettings(data: string): void {
    const action = resolveConfiguredAction(data, "settingsModal", this.config);
    if (action === "close") this.closeSettings();
    else if (action === "nextOption") {
      this.settingsCursor = Math.min(SETTINGS_ROWS.length - 1, this.settingsCursor + 1);
      this.resetArmedUntil = 0;
      this.refresh();
    } else if (action === "previousOption") {
      this.settingsCursor = Math.max(0, this.settingsCursor - 1);
      this.resetArmedUntil = 0;
      this.refresh();
    } else if (action === "toggle") void this.toggleSetting();
  }

  private handleEditor(data: string): void {
    const context = this.mode === "custom" ? "editor" : "noteEditor";
    if (this.editor.isShowingAutocomplete() && (matchesKey(data, "enter") || matchesKey(data, "escape"))) {
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    const global = resolveConfiguredAction(data, "global", this.config);
    if (global === "dismiss") {
      this.attemptCancel("dismiss");
      return;
    }
    if (global === "settings" && this.editor.getText().length === 0) {
      this.openSettings();
      return;
    }
    const action = resolveConfiguredAction(data, context, this.config);
    const empty = this.editor.getText().length === 0;
    if ((context === "editor" && action === "submit") || (context === "noteEditor" && action === "save")) {
      this.commitEditor();
      return;
    }
    if (action === "close") {
      this.commitEditor();
      return;
    }
    if (empty) {
      if (action === "nextTabWhenEmpty") return this.navigateTabs(1);
      if (action === "previousTabWhenEmpty") return this.navigateTabs(-1);
      if (action === "nextOptionWhenEmpty") { moveCursor(this.state, 1); this.refresh(); return; }
      if (action === "previousOptionWhenEmpty") { moveCursor(this.state, -1); this.refresh(); return; }
    }
    this.editor.handleInput(data);
    this.refresh();
  }

  private reviewAction(index: number, numeric = false): void {
    this.state.reviewCursor = index;
    if (numeric && this.config.behaviour.doublePressReviewShortcuts) {
      if (this.state.pendingReviewShortcut !== index) {
        this.state.pendingReviewShortcut = index;
        this.refresh();
        return;
      }
    }
    this.state.pendingReviewShortcut = undefined;
    if (index === 0) this.complete(buildResult(this.state, "submit"));
    else if (index === 1) this.complete(buildResult(this.state, "elaborate"));
    else this.attemptCancel("cancel");
  }

  private chooseCurrent(toggle: boolean): void {
    const question = activeQuestion(this.state);
    if (!question) return;
    if (question.freeform) {
      this.startEditor("custom", draftFor(this.state, question.id).customText ?? "");
      return;
    }
    const custom = this.state.cursor === question.options.length;
    if (custom) {
      const outcome = toggleCustom(this.state, question);
      if (outcome === "edit") this.startEditor("custom", draftFor(this.state, question.id).customText ?? "");
      else this.refresh();
      return;
    }
    const option = question.options[this.state.cursor];
    if (!option) return;
    selectDeclared(this.state, question, option.value);
    if (presentedType(this.state, question) !== "multi" && !toggle) this.navigateTabs(1);
    else this.refresh();
  }

  private numericShortcut(number: number): void {
    if (this.onReview()) {
      if (number <= 3) this.reviewAction(number - 1, true);
      return;
    }
    const question = activeQuestion(this.state);
    if (question && !question.freeform && number <= question.options.length + 1) {
      this.state.cursor = number - 1;
      this.chooseCurrent(true);
    }
  }

  private handleMain(data: string): void {
    if (/^[1-9]$/.test(data)) {
      clearTypeConfirmation(this.state);
      this.numericShortcut(Number(data));
      return;
    }
    const action = resolveConfiguredAction(data, "main", this.config);
    if (action !== "changeQuestionType") clearTypeConfirmation(this.state);
    if (action === "settings") return this.openSettings();
    if (action === "dismiss") return this.attemptCancel("dismiss");
    if (action === "nextTab") return this.navigateTabs(1);
    if (action === "previousTab") return this.navigateTabs(-1);
    if (action === "nextOption") { moveCursor(this.state, 1); this.refresh(); return; }
    if (action === "previousOption") { moveCursor(this.state, -1); this.refresh(); return; }
    if (this.onReview()) {
      if (action === "confirm") this.reviewAction(this.state.reviewCursor);
      else if (action === "cancel") this.attemptCancel("cancel");
      return;
    }
    const question = activeQuestion(this.state)!;
    if (action === "cancel") return this.attemptCancel("cancel");
    if (action === "changeQuestionType") {
      const status = requestTypeToggle(this.state, question);
      if (!this.state.dirtyDismiss) {
        this.warning = status === "confirm" ? "Changing to single-select drops extra selections. Press the type key again to confirm." : undefined;
      }
      this.refresh();
      return;
    }
    if (action === "questionNote") {
      this.startEditor("question-note", draftFor(this.state, question.id).note ?? "");
      return;
    }
    if (action === "optionNote" && this.state.cursor < question.options.length) {
      const value = question.options[this.state.cursor]!.value;
      this.startEditor("option-note", draftFor(this.state, question.id).optionNotes.get(value) ?? "", value);
      return;
    }
    if (action === "toggle") {
      this.chooseCurrent(true);
      return;
    }
    if (action === "confirm") {
      if (presentedType(this.state, question) === "multi" && this.state.cursor < question.options.length) this.navigateTabs(1);
      else this.chooseCurrent(false);
    }
  }

  handleInput(data: string): void {
    if (this.completed) return;
    if (this.mode === "settings") this.handleSettings(data);
    else if (this.isEditing()) this.handleEditor(data);
    else this.handleMain(data);
  }

  render(width: number): string[] {
    const view: AskRenderView = {
      mode: this.mode,
      ...(this.isEditing() ? {
        editorLines: this.editor.render(inlineEditorWidth(this.state, width, this.mode)),
        editorHint: editorBindingHint(this.config, this.mode === "custom" ? "submit" : "save"),
      } : {}),
      ...(this.editorTargetValue ? { editorTargetValue: this.editorTargetValue } : {}),
      ...(this.warning ? { warning: this.warning } : {}),
      settingsCursor: this.settingsCursor,
      ...(this.settingsMessage ? { settingsMessage: this.settingsMessage } : {}),
      resetArmed: Date.now() <= this.resetArmedUntil,
      configPath: this.store.path,
    };
    return renderAsk(this.state, this.config, this.theme, width, view);
  }
}

export interface ShowAskOptions {
  source: AskSource;
  toolCallId?: string;
  signal?: AbortSignal;
  remote: RemoteAskRegistry;
}

export async function showAskFlow(
  ctx: ExtensionContext,
  form: AskForm,
  store: ConfigStore,
  options: ShowAskOptions,
): Promise<AskResult> {
  if (!await store.ensureCreated()) ctx.ui.notify(`Could not create ask configuration at ${store.path}; using in-memory defaults.`, "error");
  let remoteFlowId: string | undefined;
  let abortListener: (() => void) | undefined;
  let component: AskComponent | undefined;
  let result: AskResult | undefined;
  try {
    result = await ctx.ui.custom<AskResult>((tui, theme, _keybindings, done) => {
      component = new AskComponent(tui, theme, form, ctx.cwd, store, done, (message, type) => ctx.ui.notify(message, type));
      const remote = options.remote.open(form, options.source, (value) => component?.settle(value), options.toolCallId);
      remoteFlowId = remote.flowId;
      if (!component.settled && options.signal) {
        const abort = () => component?.settle(cancelledResult(form, "ask_user was aborted."));
        if (options.signal.aborted) queueMicrotask(abort);
        else {
          options.signal.addEventListener("abort", abort, { once: true });
          abortListener = () => options.signal?.removeEventListener("abort", abort);
        }
      }
      if (!component.settled && !options.signal?.aborted) queueMicrotask(() => void notifyWaiting(form, store.get()));
      return component;
    });
    return result;
  } finally {
    abortListener?.();
    component?.dispose();
    if (remoteFlowId) options.remote.complete(remoteFlowId, result ?? cancelledResult(form, "ask_user UI closed unexpectedly."));
  }
}

export async function showAskSettings(ctx: ExtensionContext, store: ConfigStore): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify(`Ask settings require TUI mode. Edit ${store.path}`, "warning");
    return;
  }
  const form: AskForm = { title: "Ask settings", questions: [] };
  let component: AskComponent | undefined;
  try {
    await ctx.ui.custom<AskResult>((tui, theme, _keybindings, done) => {
      component = new AskComponent(tui, theme, form, ctx.cwd, store, done, (message, type) => ctx.ui.notify(message, type), true);
      return component;
    }, { overlay: true, overlayOptions: { width: "75%", maxHeight: "80%", anchor: "center", minWidth: 60 } });
  } finally {
    component?.dispose();
  }
}
