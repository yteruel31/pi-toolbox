/**
 * Runs view: list of active/settled runs with refresh, cancellation, and a
 * takeover/detail view showing bounded progress and final output.
 *
 * Pure reducer + line producers. Side effects leave the reducer as typed
 * intents; fresh data enters as events. The concrete binding maps intents to
 * RunManager/ctx.ui calls (`request-refresh` → manager.list(), `request-
 * cancel` → manager.cancel(), `confirm-cancel` → ctx.ui.confirm(), `focus-
 * takeover` → OverlayHandle.focus()/unfocus()) and re-dispatches results as
 * events. Nothing in here touches a terminal.
 */

import { isSettledStatus } from "../shared/types.js";
import type { RunInspection, RunListEntry } from "../shared/types.js";
import type { KeyHint, RunsKeyAction } from "./keys.js";
import {
  fitHeadTailLines,
  fitLine,
  fitViewport,
  formatElapsed,
  boundNotice,
  statusGlyph,
  wrapText,
} from "./text.js";

export interface RunsViewState {
  runs: readonly RunListEntry[];
  selectedIndex: number;
  mode: "list" | "detail";
  detail:
    | {
        runId: string;
        inspection: RunInspection | undefined;
        /** True while the detail panel has captured the keyboard. */
        takeover: boolean;
      }
    | undefined;
  /** Run awaiting cancellation confirmation, if any. */
  pendingCancelId: string | undefined;
  /** Bounded transient message shown in the view. */
  notice: string | undefined;
  closed: boolean;
}

export type RunsViewEvent =
  | { kind: "key"; action: RunsKeyAction }
  | { kind: "runs-updated"; runs: readonly RunListEntry[] }
  | { kind: "inspection-updated"; inspection: RunInspection }
  | { kind: "cancel-confirmed"; runId: string; confirmed: boolean };

export type RunsViewIntent =
  | { kind: "request-refresh" }
  | { kind: "request-inspection"; runId: string }
  | { kind: "confirm-cancel"; runId: string; title: string }
  | { kind: "request-cancel"; runId: string }
  | { kind: "focus-takeover"; runId: string; active: boolean }
  | { kind: "close" };

export interface RunsViewStep {
  state: RunsViewState;
  intents: RunsViewIntent[];
}

export function initialRunsViewState(
  runs: readonly RunListEntry[] = [],
): RunsViewState {
  return {
    runs,
    selectedIndex: 0,
    mode: "list",
    detail: undefined,
    pendingCancelId: undefined,
    notice: undefined,
    closed: false,
  };
}

function clampIndex(state: RunsViewState, index: number): number {
  if (state.runs.length === 0) return 0;
  return Math.min(Math.max(0, index), state.runs.length - 1);
}

function selectedRun(state: RunsViewState): RunListEntry | undefined {
  return state.runs[state.selectedIndex];
}

function step(state: RunsViewState, intents: RunsViewIntent[] = []): RunsViewStep {
  return { state, intents };
}

export function reduceRunsView(
  state: RunsViewState,
  event: RunsViewEvent,
): RunsViewStep {
  if (state.closed) return step(state);
  switch (event.kind) {
    case "runs-updated":
      return step(applyRunsUpdate(state, event.runs));
    case "inspection-updated":
      return step(applyInspectionUpdate(state, event.inspection));
    case "cancel-confirmed":
      return applyCancelConfirmation(state, event.runId, event.confirmed);
    case "key":
      return state.mode === "detail"
        ? reduceDetailKey(state, event.action)
        : reduceListKey(state, event.action);
  }
}

function applyRunsUpdate(
  state: RunsViewState,
  runs: readonly RunListEntry[],
): RunsViewState {
  // Keep the selection anchored to the same run id across refreshes.
  const selectedId = selectedRun(state)?.id;
  const nextIndex =
    selectedId === undefined
      ? 0
      : runs.findIndex((run) => run.id === selectedId);
  const next: RunsViewState = {
    ...state,
    runs,
    selectedIndex: nextIndex >= 0 ? nextIndex : 0,
  };
  next.selectedIndex = clampIndex(next, next.selectedIndex);
  return next;
}

function applyInspectionUpdate(
  state: RunsViewState,
  inspection: RunInspection,
): RunsViewState {
  if (!state.detail || state.detail.runId !== inspection.id) return state;
  return { ...state, detail: { ...state.detail, inspection } };
}

function applyCancelConfirmation(
  state: RunsViewState,
  runId: string,
  confirmed: boolean,
): RunsViewStep {
  if (state.pendingCancelId !== runId) return step(state);
  const next = { ...state, pendingCancelId: undefined };
  if (!confirmed) return step(next);
  return step(
    { ...next, notice: boundNotice(`Cancellation requested for ${runId}.`) },
    [{ kind: "request-cancel", runId }, { kind: "request-refresh" }],
  );
}

function requestCancel(state: RunsViewState, runId: string): RunsViewStep {
  const run = state.runs.find((candidate) => candidate.id === runId);
  const inspection =
    state.detail?.runId === runId ? state.detail.inspection : undefined;
  const status = inspection?.status ?? run?.status;
  const title = inspection?.title ?? run?.title ?? runId;
  if (status && isSettledStatus(status)) {
    return step({
      ...state,
      notice: boundNotice(`${runId} already ${status}; nothing to cancel.`),
    });
  }
  return step({ ...state, pendingCancelId: runId, notice: undefined }, [
    { kind: "confirm-cancel", runId, title },
  ]);
}

function reduceListKey(
  state: RunsViewState,
  action: RunsKeyAction,
): RunsViewStep {
  switch (action) {
    case "up":
      return step({
        ...state,
        selectedIndex: clampIndex(state, state.selectedIndex - 1),
      });
    case "down":
      return step({
        ...state,
        selectedIndex: clampIndex(state, state.selectedIndex + 1),
      });
    case "enter": {
      const run = selectedRun(state);
      if (!run) return step(state);
      return step(
        {
          ...state,
          mode: "detail",
          detail: { runId: run.id, inspection: undefined, takeover: false },
          notice: undefined,
        },
        [{ kind: "request-inspection", runId: run.id }],
      );
    }
    case "refresh":
      return step({ ...state, notice: undefined }, [{ kind: "request-refresh" }]);
    case "cancel-run": {
      const run = selectedRun(state);
      if (!run) return step(state);
      return requestCancel(state, run.id);
    }
    case "takeover":
      return step(state);
    case "escape":
      return step({ ...state, closed: true }, [{ kind: "close" }]);
  }
}

function reduceDetailKey(
  state: RunsViewState,
  action: RunsKeyAction,
): RunsViewStep {
  const detail = state.detail;
  if (!detail) return step({ ...state, mode: "list" });
  switch (action) {
    case "escape": {
      // Layered exit: takeover → detail → list. Closing the view entirely
      // still requires escape from the list.
      if (detail.takeover) {
        return step(
          { ...state, detail: { ...detail, takeover: false } },
          [{ kind: "focus-takeover", runId: detail.runId, active: false }],
        );
      }
      return step({ ...state, mode: "list", detail: undefined });
    }
    case "takeover": {
      const active = !detail.takeover;
      return step(
        { ...state, detail: { ...detail, takeover: active } },
        [{ kind: "focus-takeover", runId: detail.runId, active }],
      );
    }
    case "refresh":
      return step({ ...state, notice: undefined }, [
        { kind: "request-inspection", runId: detail.runId },
        { kind: "request-refresh" },
      ]);
    case "cancel-run":
      return requestCancel(state, detail.runId);
    case "up":
    case "down":
    case "enter":
      return step(state);
  }
}

// ---------------------------------------------------------------------------
// Line producers (plain text, hard-bounded to width/maxRows)
// ---------------------------------------------------------------------------

export const RUNS_LIST_KEY_HINTS: readonly KeyHint[] = [
  { key: "↑↓", description: "move" },
  { key: "enter", description: "detail" },
  { key: "r", description: "refresh" },
  { key: "c", description: "cancel" },
  { key: "esc", description: "close" },
];

export const RUN_DETAIL_KEY_HINTS: readonly KeyHint[] = [
  { key: "t", description: "takeover" },
  { key: "r", description: "refresh" },
  { key: "c", description: "cancel" },
  { key: "esc", description: "back" },
];

export function formatRunRow(
  run: RunListEntry,
  selected: boolean,
  width: number,
): string {
  const marker = selected ? "›" : " ";
  const model = run.model ? ` ${run.model}` : "";
  const row = `${marker} ${statusGlyph(run.status)} ${run.id} [${run.harness}] ${run.title} · ${run.status} ${formatElapsed(run.elapsedMs)}${model}`;
  return fitLine(row, width);
}

/** Render the list mode as bounded plain-text lines. */
export function runsListLines(
  state: RunsViewState,
  width: number,
  maxRows: number,
): string[] {
  if (width <= 0 || maxRows <= 0) return [];
  const notice = state.notice
    ? [fitLine(`! ${state.notice}`, width)]
    : [];
  const available = Math.max(0, maxRows - notice.length);
  const rows =
    state.runs.length === 0
      ? [fitLine("No subagent runs yet.", width)]
      : state.runs.map((run, index) =>
          formatRunRow(run, index === state.selectedIndex, width),
        );
  const visible =
    state.runs.length === 0
      ? rows.slice(0, available)
      : fitViewport(rows, state.selectedIndex, width, available);
  return [...visible, ...notice].slice(0, maxRows);
}

/** Render the detail/takeover mode as bounded plain-text lines. */
export function runDetailLines(
  state: RunsViewState,
  width: number,
  maxRows: number,
): string[] {
  const detail = state.detail;
  if (!detail) return [];
  const inspection = detail.inspection;
  const lines: string[] = [];
  if (!inspection) {
    lines.push(fitLine(`${detail.runId} · loading…`, width));
  } else {
    const model = inspection.model ? ` · ${inspection.model}` : "";
    lines.push(
      fitLine(
        `${statusGlyph(inspection.status)} ${inspection.id} [${inspection.harness}] ${inspection.title}`,
        width,
      ),
    );
    lines.push(
      fitLine(
        `${inspection.status}${inspection.cancelRequested ? " (cancel requested)" : ""} · ${formatElapsed(inspection.elapsedMs)}${model}`,
        width,
      ),
    );
    if (inspection.activity.length > 0 || inspection.activityDropped > 0) {
      lines.push(fitLine("activity:", width));
      if (inspection.activityDropped > 0) {
        lines.push(
          fitLine(`… ${inspection.activityDropped} earlier entries`, width),
        );
      }
      for (const entry of inspection.activity) {
        lines.push(fitLine(`• ${entry.text}`, width));
      }
    }
    if (inspection.resultPreview !== undefined) {
      lines.push(fitLine("output:", width));
      lines.push(...wrapText(inspection.resultPreview, width));
    }
  }
  if (detail.takeover) lines.push(fitLine("[takeover: keys captured]", width));
  if (state.notice) lines.push(fitLine(`! ${state.notice}`, width));
  return fitHeadTailLines(lines, width, maxRows, inspection ? 2 : 1);
}
