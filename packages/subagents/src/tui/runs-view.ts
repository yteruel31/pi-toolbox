import { isSettledStatus } from "../shared/types.js";
import type { RunInspection, RunListEntry } from "../shared/types.js";
import type { KeyHint, RunsKeyAction } from "./keys.js";
import {
  boundNotice,
  fitHeadTailLines,
  fitLine,
  fitViewport,
  formatElapsed,
  statusGlyph,
  wrapText,
} from "./text.js";

const TRANSCRIPT_PAGE_ENTRIES = 5;

export interface RunsViewState {
  runs: readonly RunListEntry[];
  selectedIndex: number;
  mode: "list" | "detail";
  detail:
    | {
        runId: string;
        inspection: RunInspection | undefined;
        /** Number of newer transcript entries hidden below the viewport. */
        scrollOffset: number;
        /** New events follow the tail only while this remains true. */
        tailFollow: boolean;
        submitting: boolean;
      }
    | undefined;
  pendingCancelId: string | undefined;
  notice: string | undefined;
  closed: boolean;
}

export type RunsViewEvent =
  | { kind: "key"; action: RunsKeyAction }
  | { kind: "runs-updated"; runs: readonly RunListEntry[] }
  | { kind: "inspection-updated"; inspection: RunInspection }
  | { kind: "cancel-confirmed"; runId: string; confirmed: boolean }
  | { kind: "submission-started"; runId: string }
  | { kind: "submission-finished"; runId: string; error?: string };

export type RunsViewIntent =
  | { kind: "request-refresh" }
  | { kind: "request-inspection"; runId: string }
  | { kind: "confirm-cancel"; runId: string; title: string }
  | { kind: "request-cancel"; runId: string }
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
    case "submission-started":
      return step(updateSubmission(state, event.runId, true));
    case "submission-finished":
      return step({
        ...updateSubmission(state, event.runId, false),
        notice: event.error ? boundNotice(event.error) : undefined,
      });
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
  const selectedId = selectedRun(state)?.id;
  const nextIndex = selectedId === undefined
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
  const detail = state.detail;
  if (!detail || detail.runId !== inspection.id) return state;
  const previousTotal = detail.inspection
    ? detail.inspection.transcriptDropped + detail.inspection.transcript.length
    : 0;
  const nextTotal = inspection.transcriptDropped + inspection.transcript.length;
  const added = Math.max(0, nextTotal - previousTotal);
  const scrollOffset = detail.tailFollow
    ? 0
    : Math.min(Math.max(0, nextTotal - 1), detail.scrollOffset + added);
  return {
    ...state,
    detail: {
      ...detail,
      inspection,
      scrollOffset,
      tailFollow: scrollOffset === 0,
    },
  };
}

function updateSubmission(
  state: RunsViewState,
  runId: string,
  submitting: boolean,
): RunsViewState {
  if (!state.detail || state.detail.runId !== runId) return state;
  return {
    ...state,
    detail: { ...state.detail, submitting },
    notice: submitting ? undefined : state.notice,
  };
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
  const inspection = state.detail?.runId === runId
    ? state.detail.inspection
    : undefined;
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
      return step({ ...state, selectedIndex: clampIndex(state, state.selectedIndex - 1) });
    case "down":
      return step({ ...state, selectedIndex: clampIndex(state, state.selectedIndex + 1) });
    case "enter": {
      const run = selectedRun(state);
      if (!run) return step(state);
      return step(
        {
          ...state,
          mode: "detail",
          detail: {
            runId: run.id,
            inspection: undefined,
            scrollOffset: 0,
            tailFollow: true,
            submitting: false,
          },
          notice: undefined,
        },
        [{ kind: "request-inspection", runId: run.id }],
      );
    }
    case "refresh":
      return step({ ...state, notice: undefined }, [{ kind: "request-refresh" }]);
    case "cancel-run": {
      const run = selectedRun(state);
      return run ? requestCancel(state, run.id) : step(state);
    }
    case "page-up":
    case "page-down":
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
  const transcriptLength = detail.inspection?.transcript.length ?? 0;
  switch (action) {
    case "escape":
      return step({ ...state, mode: "list", detail: undefined, notice: undefined });
    case "page-up": {
      const scrollOffset = Math.min(
        Math.max(0, transcriptLength - 1),
        detail.scrollOffset + TRANSCRIPT_PAGE_ENTRIES,
      );
      return step({
        ...state,
        detail: { ...detail, scrollOffset, tailFollow: scrollOffset === 0 },
      });
    }
    case "page-down": {
      const scrollOffset = Math.max(0, detail.scrollOffset - TRANSCRIPT_PAGE_ENTRIES);
      return step({
        ...state,
        detail: { ...detail, scrollOffset, tailFollow: scrollOffset === 0 },
      });
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

export const RUNS_LIST_KEY_HINTS: readonly KeyHint[] = [
  { key: "↑↓", description: "move" },
  { key: "enter", description: "open" },
  { key: "r", description: "refresh" },
  { key: "x", description: "cancel" },
  { key: "esc", description: "close" },
];

export const RUN_DETAIL_KEY_HINTS: readonly KeyHint[] = [
  { key: "pgup/pgdn", description: "scroll" },
  { key: "r", description: "refresh" },
  { key: "x", description: "cancel" },
  { key: "esc", description: "back" },
];

export function formatRunRow(
  run: RunListEntry,
  selected: boolean,
  width: number,
): string {
  const marker = selected ? "›" : " ";
  const model = run.model ? ` ${run.model}` : "";
  return fitLine(
    `${marker} ${statusGlyph(run.status)} ${run.id} [${run.harness}] ${run.title} · ${run.status} ${formatElapsed(run.elapsedMs)}${model}`,
    width,
  );
}

export function runsListLines(
  state: RunsViewState,
  width: number,
  maxRows: number,
): string[] {
  if (width <= 0 || maxRows <= 0) return [];
  const notice = state.notice ? [fitLine(`! ${state.notice}`, width)] : [];
  const available = Math.max(0, maxRows - notice.length);
  const rows = state.runs.length === 0
    ? [fitLine("No subagent runs yet.", width)]
    : state.runs.map((run, index) => formatRunRow(run, index === state.selectedIndex, width));
  const visible = state.runs.length === 0
    ? rows.slice(0, available)
    : fitViewport(rows, state.selectedIndex, width, available);
  return [...visible, ...notice].slice(0, maxRows);
}

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
    lines.push(fitLine(
      `${statusGlyph(inspection.status)} ${inspection.id} [${inspection.harness}] ${inspection.title}`,
      width,
    ));
    lines.push(fitLine(
      `${inspection.status}${inspection.cancelRequested ? " (cancel requested)" : ""} · ${formatElapsed(inspection.elapsedMs)}${model}`,
      width,
    ));
    if (inspection.transcriptDropped > 0) {
      lines.push(fitLine(`… ${inspection.transcriptDropped} earlier transcript entries`, width));
    }
    for (const entry of inspection.transcript) {
      switch (entry.kind) {
        case "status": lines.push(fitLine(`· ${entry.text}`, width)); break;
        case "user": lines.push(...wrapText(`user: ${entry.text}`, width)); break;
        case "assistant": lines.push(...wrapText(`assistant: ${entry.text}`, width)); break;
        case "tool":
          lines.push(fitLine(`tool ${entry.toolName} ${entry.phase}${entry.callId ? ` (${entry.callId})` : ""}`, width));
          if (entry.input) lines.push(...wrapText(`input: ${entry.input}`, width));
          if (entry.output) lines.push(...wrapText(`output: ${entry.output}`, width));
      }
    }
    lines.push(fitLine(
      inspection.messaging.editable
        ? "message editor available"
        : inspection.messaging.reason ?? "transcript is read-only",
      width,
    ));
  }
  if (state.notice) lines.push(fitLine(`! ${state.notice}`, width));
  return fitHeadTailLines(lines, width, maxRows, inspection ? 2 : 1);
}
