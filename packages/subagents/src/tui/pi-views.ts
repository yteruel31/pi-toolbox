import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type TUI,
} from "@earendil-works/pi-tui";

import type { RoutingDataPort, RunsDataPort } from "./binding.js";
import type { RoutingKeyAction, RunsKeyAction } from "./keys.js";
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
} from "./routing-editor.js";
import {
  ROUTING_KEY_HINTS,
  type RoutingViewIntent,
} from "./routing-view.js";
import {
  RUN_DETAIL_KEY_HINTS,
  RUNS_LIST_KEY_HINTS,
  type RunsViewIntent,
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
  let handle: OverlayHandle | undefined;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new RunsOverlayComponent(tui, theme, data, done, {
        confirm: (title) => ctx.ui.confirm("Cancel subagent?", title),
        takeover(active) {
          if (active) handle?.focus();
          else handle?.unfocus();
        },
      }),
    {
      overlay: true,
      overlayOptions: FULL_SCREEN_PANEL_OPTIONS,
      onHandle: (next) => {
        handle = next;
        next.focus();
      },
    },
  );
}

/** Open the saved-routing editor as a fresh experimental Pi overlay. */
export async function openPiRoutingOverlay(
  ctx: ExtensionContext,
  data: RoutingDataPort,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new RoutingOverlayComponent(tui, theme, data, ctx, done),
    {
      overlay: true,
      overlayOptions: FULL_SCREEN_PANEL_OPTIONS,
    },
  );
}

class RunsOverlayComponent implements Component {
  private readonly model: RunsViewModel;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    data: RunsDataPort,
    private readonly done: () => void,
    private readonly actions: {
      confirm(title: string): Promise<boolean>;
      takeover(active: boolean): void;
    },
  ) {
    let model!: RunsViewModel;
    model = createRunsViewModel({
      data,
      onChange: () => tui.requestRender(),
      onIntent: (intent) => this.handleIntent(model, intent),
    });
    this.model = model;
  }

  render(width: number): string[] {
    return renderRunsPanel(
      this.theme,
      this.model.getState(),
      width,
      this.tui.terminal.rows,
      RUNS_LIST_KEY_HINTS,
      RUN_DETAIL_KEY_HINTS,
    );
  }

  handleInput(data: string): void {
    const action = runsAction(data);
    if (action) this.model.dispatch({ kind: "key", action });
  }

  invalidate(): void {
    this.model.refresh();
    this.tui.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.model.dispose();
  }

  private handleIntent(model: RunsViewModel, intent: RunsViewIntent): void {
    switch (intent.kind) {
      case "confirm-cancel":
        void this.actions.confirm(`${intent.runId}: ${intent.title}`).then((confirmed) => {
          model.dispatch({ kind: "cancel-confirmed", runId: intent.runId, confirmed });
        });
        return;
      case "focus-takeover":
        this.actions.takeover(intent.active);
        return;
      case "close":
        this.done();
        return;
      default:
        return;
    }
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
        this.editor = createRoutingEditorState(intent.session);
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

function runsAction(data: string): RunsKeyAction | undefined {
  if (matchesKey(data, Key.up)) return "up";
  if (matchesKey(data, Key.down)) return "down";
  if (matchesKey(data, Key.enter)) return "enter";
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return "escape";
  if (matchesKey(data, "r")) return "refresh";
  if (matchesKey(data, "c")) return "cancel-run";
  if (matchesKey(data, "t")) return "takeover";
  return undefined;
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
