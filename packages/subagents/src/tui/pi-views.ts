import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";

import type { RoutingEntry } from "../agents/types.js";
import type { RoutingDataPort, RunsDataPort } from "./binding.js";
import {
  formatKeyHints,
  type RoutingKeyAction,
  type RunsKeyAction,
} from "./keys.js";
import {
  ROUTING_KEY_HINTS,
  routingListLines,
  type RoutingEditSession,
  type RoutingViewIntent,
} from "./routing-view.js";
import {
  RUN_DETAIL_KEY_HINTS,
  RUNS_LIST_KEY_HINTS,
  runDetailLines,
  runsListLines,
  type RunsViewIntent,
} from "./runs-view.js";
import { fitLine } from "./text.js";
import {
  createRoutingViewModel,
  createRunsViewModel,
  type RoutingViewModel,
  type RunsViewModel,
} from "./view-models.js";

const PANEL_ROWS = 20;

/** Open the live run inspector as a fresh experimental Pi overlay. */
export async function openPiRunsOverlay(
  ctx: ExtensionContext,
  data: RunsDataPort,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  let handle: OverlayHandle | undefined;
  await ctx.ui.custom<void>(
    (tui, _theme, _keybindings, done) =>
      new RunsOverlayComponent(tui, data, done, {
        confirm: (title) => ctx.ui.confirm("Cancel subagent?", title),
        takeover(active) {
          if (active) handle?.focus();
          else handle?.unfocus();
        },
      }),
    {
      overlay: true,
      overlayOptions: {
        width: "65%",
        minWidth: 48,
        maxHeight: "80%",
        anchor: "right-center",
        margin: 1,
      },
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
    (tui, _theme, _keybindings, done) =>
      new RoutingOverlayComponent(tui, data, ctx, done),
    {
      overlay: true,
      overlayOptions: {
        width: "72%",
        minWidth: 58,
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      },
    },
  );
}

class RunsOverlayComponent implements Component {
  private readonly model: RunsViewModel;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
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
    const state = this.model.getState();
    const hints = state.mode === "detail" ? RUN_DETAIL_KEY_HINTS : RUNS_LIST_KEY_HINTS;
    const body = state.mode === "detail"
      ? runDetailLines(state, width, PANEL_ROWS)
      : runsListLines(state, width, PANEL_ROWS);
    return [
      fitLine("Subagent runs", width),
      ...body,
      fitLine(formatKeyHints(hints), width),
    ];
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
  private disposed = false;

  constructor(
    private readonly tui: TUI,
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
    return [
      fitLine("Named-agent routing", width),
      ...routingListLines(this.model.getState(), width, PANEL_ROWS),
      fitLine(formatKeyHints(ROUTING_KEY_HINTS), width),
    ];
  }

  handleInput(data: string): void {
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
        void editRoutingEntry(this.ctx, intent.session).then((entry) => {
          model.dispatch(entry
            ? { kind: "edit-committed", entry }
            : { kind: "edit-cancelled" });
        });
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

async function editRoutingEntry(
  ctx: ExtensionContext,
  session: RoutingEditSession,
): Promise<RoutingEntry | undefined> {
  const currentHarness = session.current.harness ?? "inherit";
  const harnessChoice = await ctx.ui.select(
    `${session.agentName} · ${session.scope} harness`,
    [currentHarness, ...["inherit", "pi", "claude"].filter((value) => value !== currentHarness)],
  );
  if (harnessChoice === undefined) return undefined;
  const model = await ctx.ui.editor(
    `${session.agentName} · model (empty inherits)`,
    typeof session.current.model === "string" ? session.current.model : "",
  );
  if (model === undefined) return undefined;
  const currentThinking = session.current.thinking ?? "inherit";
  const thinkingChoice = await ctx.ui.select(
    `${session.agentName} · thinking`,
    [
      currentThinking,
      ...["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"]
        .filter((value) => value !== currentThinking),
    ],
  );
  if (thinkingChoice === undefined) return undefined;
  return {
    ...(harnessChoice === "pi" || harnessChoice === "claude" ? { harness: harnessChoice } : {}),
    ...(model.trim() ? { model: model.trim() } : {}),
    ...(thinkingChoice !== "inherit" ? { thinking: thinkingChoice as RoutingEntry["thinking"] } : {}),
  };
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
