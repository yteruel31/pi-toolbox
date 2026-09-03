import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

import type { RoutingDataPort, RunsDataPort } from "./binding.js";
import type { RoutingKeyAction, RunsKeyAction } from "./keys.js";
import { loadRoutingModelCatalog } from "./model-catalog.js";
import {
  renderRoutingEditorPanel,
  renderRoutingPanel,
  renderRunsPanel,
} from "./pi-panel-renderer.js";
import {
  createRoutingEditorState,
  reduceRoutingEditorInput,
  ROUTING_EDITOR_KEY_HINTS,
  type RoutingEditorState,
  type RoutingModelCatalog,
} from "./routing-editor.js";
import {
  ROUTING_KEY_HINTS,
  type RoutingViewIntent,
} from "./routing-view.js";
import {
  RUN_CANCEL_KEY_HINTS,
  RUN_DETAIL_KEY_HINTS,
  RUNS_LIST_KEY_HINTS,
  type RunsViewIntent,
  type RunsViewState,
} from "./runs-view.js";
import {
  createRoutingViewModel,
  createRunsViewModel,
  type RoutingViewModel,
  type RunsViewModel,
} from "./view-models.js";

export const FULL_SCREEN_PANEL_OPTIONS = {
  width: "100%",
  maxHeight: "100%",
  anchor: "center",
  margin: 0,
} satisfies OverlayOptions;

/** Open the live run inspector as a fresh experimental Pi overlay. */
export async function openPiRunsOverlay(
  ctx: ExtensionContext,
  data: RunsDataPort,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new RunsOverlayComponent(tui, theme, data, done),
    {
      overlay: true,
      overlayOptions: FULL_SCREEN_PANEL_OPTIONS,
      onHandle: (handle) => handle.focus(),
    },
  );
}

/** Open the saved-routing editor as a fresh experimental Pi overlay. */
export async function openPiRoutingOverlay(
  ctx: ExtensionContext,
  data: RoutingDataPort,
  modelCatalog?: RoutingModelCatalog,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  const loaded = modelCatalog
    ? { catalog: modelCatalog }
    : await loadRoutingModelCatalog(ctx);
  if (loaded.claudeWarning) {
    ctx.ui.notify(
      `Claude model catalogue unavailable: ${loaded.claudeWarning}`,
      "warning",
    );
  }
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new RoutingOverlayComponent(tui, theme, data, ctx, done, loaded.catalog),
    {
      overlay: true,
      overlayOptions: FULL_SCREEN_PANEL_OPTIONS,
    },
  );
}

export class RunsOverlayComponent implements Component, Focusable {
  private readonly model: RunsViewModel;
  private readonly editor: Editor;
  private _focused = false;
  private disposed = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncEditorFocus();
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    data: RunsDataPort,
    private readonly done: () => void,
  ) {
    this.editor = new Editor(tui, {
      borderColor: (text) => theme.fg("borderAccent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    }, { paddingX: 1 });
    this.editor.onSubmit = (text) => void this.submitMessage(text);
    let model!: RunsViewModel;
    model = createRunsViewModel({
      data,
      onChange: () => {
        this.syncEditorFocus();
        tui.requestRender();
      },
      onIntent: (intent) => this.handleIntent(model, intent),
    });
    this.model = model;
  }

  render(width: number): string[] {
    const state = this.model.getState();
    this.syncEditorFocus();
    const editorLines = isRunEditorVisible(state)
      ? this.editor.render(Math.max(1, width - 6))
      : undefined;
    return renderRunsPanel(
      this.theme,
      state,
      width,
      this.tui.terminal.rows,
      state.pendingCancelId ? RUN_CANCEL_KEY_HINTS : RUNS_LIST_KEY_HINTS,
      state.pendingCancelId ? RUN_CANCEL_KEY_HINTS : RUN_DETAIL_KEY_HINTS,
      editorLines,
    );
  }

  handleInput(data: string): void {
    const state = this.model.getState();
    if (state.pendingCancelId) {
      if (matchesKey(data, "y") || matchesKey(data, Key.enter)) {
        this.model.dispatch({
          kind: "cancel-confirmed",
          runId: state.pendingCancelId,
          confirmed: true,
        });
      } else if (matchesKey(data, "n") || matchesKey(data, Key.escape)) {
        this.model.dispatch({
          kind: "cancel-confirmed",
          runId: state.pendingCancelId,
          confirmed: false,
        });
      }
      this.tui.requestRender();
      return;
    }
    if (state.mode === "detail") {
      if (matchesKey(data, Key.escape)) {
        if (this.editor.isShowingAutocomplete()) this.editor.handleInput(data);
        else this.model.dispatch({ kind: "key", action: "escape" });
        this.tui.requestRender();
        return;
      }
      const action = detailRunsAction(data);
      if (action) {
        this.model.dispatch({ kind: "key", action });
        return;
      }
      if (isRunEditorActive(state)) {
        this.editor.handleInput(data);
        this.tui.requestRender();
      }
      return;
    }
    const action = listRunsAction(data);
    if (action) this.model.dispatch({ kind: "key", action });
  }

  invalidate(): void {
    this.editor.invalidate();
    this.model.refresh();
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.editor.focused = false;
    this.model.dispose();
  }

  private handleIntent(_model: RunsViewModel, intent: RunsViewIntent): void {
    switch (intent.kind) {
      case "close":
        this.done();
        return;
      default:
        return;
    }
  }

  private syncEditorFocus(): void {
    const state = this.model?.getState();
    const active = state ? isRunEditorActive(state) : false;
    this.editor.focused = this._focused && active;
    this.editor.disableSubmit = !active || Boolean(state?.detail?.submitting);
  }

  private async submitMessage(text: string): Promise<void> {
    const submitted = text;
    const accepted = await this.model.submitMessage(submitted);
    if (this.disposed) return;
    if (accepted && this.editor.getExpandedText() === submitted) {
      this.editor.setText("");
    }
    this.syncEditorFocus();
    this.tui.requestRender();
  }
}

class RoutingOverlayComponent implements Component {
  private readonly model: RoutingViewModel;
  private editor: RoutingEditorState | undefined;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    data: RoutingDataPort,
    private readonly ctx: ExtensionContext,
    private readonly done: () => void,
    private readonly modelCatalog: RoutingModelCatalog,
  ) {
    let model!: RoutingViewModel;
    model = createRoutingViewModel({
      data,
      projectTrusted: ctx.isProjectTrusted(),
      onChange: () => tui.requestRender(),
      onError: (error) => {
        if (ctx.hasUI) ctx.ui.notify(`Subagent routing: ${errorMessage(error)}`, "error");
      },
      onIntent: (intent) => this.handleIntent(model, intent),
    });
    this.model = model;
  }

  render(width: number): string[] {
    if (this.editor) {
      return renderRoutingEditorPanel(
        this.theme,
        this.editor,
        width,
        this.tui.terminal.rows,
        ROUTING_EDITOR_KEY_HINTS,
      );
    }
    return renderRoutingPanel(
      this.theme,
      this.model.getState(),
      width,
      this.tui.terminal.rows,
      ROUTING_KEY_HINTS,
    );
  }

  handleInput(data: string): void {
    if (this.editor) {
      const step = reduceRoutingEditorInput(this.editor, data);
      this.editor = step.state;
      if (step.intent?.kind === "save") {
        this.editor = undefined;
        this.model.dispatch({ kind: "edit-committed", entry: step.intent.entry });
      } else if (step.intent?.kind === "cancel") {
        this.editor = undefined;
        this.model.dispatch({ kind: "edit-cancelled" });
      } else {
        this.tui.requestRender();
      }
      return;
    }
    const action = routingAction(data);
    if (action) this.model.dispatch({ kind: "key", action });
  }

  invalidate(): void {
    void this.model.refresh();
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.model.dispose();
  }

  private handleIntent(model: RoutingViewModel, intent: RoutingViewIntent): void {
    switch (intent.kind) {
      case "open-editor":
        this.editor = createRoutingEditorState(intent.session, this.modelCatalog);
        this.tui.requestRender();
        return;
      case "confirm-reset":
        void this.ctx.ui.confirm(
          `Reset invalid ${intent.scope} routing?`,
          `${intent.reason}\nThe original file will be backed up before a fresh file is written.`,
        ).then((confirmed) => {
          model.dispatch({ kind: "reset-confirmed", scope: intent.scope, confirmed });
        });
        return;
      case "close":
        this.done();
        return;
      default:
        return;
    }
  }
}

function listRunsAction(data: string): RunsKeyAction | undefined {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape)) return "escape";
  if (matchesKey(data, "r")) return "refresh";
  if (matchesKey(data, "x")) return "cancel-run";
  return undefined;
}

function detailRunsAction(data: string): RunsKeyAction | undefined {
  if (matchesKey(data, Key.pageUp)) return "page-up";
  if (matchesKey(data, Key.pageDown)) return "page-down";
  if (matchesKey(data, "r")) return "refresh";
  if (matchesKey(data, "x")) return "cancel-run";
  return undefined;
}

function isRunEditorVisible(state: RunsViewState): boolean {
  return state.mode === "detail" &&
    !state.pendingCancelId &&
    state.detail?.inspection?.messaging.editable === true;
}

function isRunEditorActive(state: RunsViewState): boolean {
  return isRunEditorVisible(state) && !state.detail?.submitting;
}

function routingAction(data: string): RoutingKeyAction | undefined {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.tab)) return "tab";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return "escape";
  if (matchesKey(data, "d")) return "delete-mapping";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
