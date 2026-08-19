import { describe, expect, it } from "vitest";
import {
  CHOOSER_ITEMS,
  chooserLines,
  commandPresentation,
  initialChooserState,
  parseSubagentsCommand,
  reduceChooser,
} from "../src/tui/command-mode.js";
import { assertBoundedRender } from "../src/tui/binding.js";
import {
  initialRunsViewState,
  reduceRunsView,
  runDetailLines,
  runsListLines,
} from "../src/tui/runs-view.js";
import type {
  RunInspection,
  RunListEntry,
} from "../src/shared/types.js";

function run(
  id: string,
  status: RunListEntry["status"] = "running",
): RunListEntry {
  return {
    id,
    title: `Task ${id}`,
    harness: "pi",
    status,
    elapsedMs: 12_345,
    model: "anthropic/test",
  };
}

function inspection(
  id: string,
  status: RunInspection["status"] = "running",
): RunInspection {
  return {
    id,
    title: `Task ${id}`,
    harness: "pi",
    status,
    createdAt: 0,
    settledAt: status === "running" ? undefined : 1,
    elapsedMs: 1,
    cancelRequested: false,
    model: "anthropic/test",
    usage: undefined,
    activity: [{ at: 1, text: "working" }],
    activityDropped: 0,
    transcript: [{ kind: "status", at: 1, text: "working" }],
    transcriptDropped: 0,
    messaging: status === "running"
      ? { supported: true, editable: true }
      : { supported: true, editable: false, reason: "read-only" },
    resultPreview: status === "running" ? undefined : "done",
    consumption: "none",
  };
}

describe("subagents command mode", () => {
  it("parses direct modes and bounds invalid argument warnings", () => {
    expect(parseSubagentsCommand(undefined)).toEqual({ mode: "chooser" });
    expect(parseSubagentsCommand(" RUNS ")).toEqual({ mode: "runs" });
    expect(parseSubagentsCommand("agents")).toEqual({ mode: "agents" });

    const parsed = parseSubagentsCommand("x".repeat(1_000));
    expect(parsed.mode).toBe("chooser");
    expect(parsed.warning?.length).toBeLessThanOrEqual(200);
  });

  it("uses interactive components only in real TUI mode", () => {
    expect(commandPresentation("tui", true)).toBe("interactive");
    expect(commandPresentation("tui", false)).toBe("text");
    expect(commandPresentation("rpc", true)).toBe("text");
    expect(commandPresentation("print", false)).toBe("text");
  });

  it("keeps chooser navigation bounded and emits one terminal intent", () => {
    let state = initialChooserState();
    state = reduceChooser(state, "up").state;
    expect(state.selectedIndex).toBe(0);
    state = reduceChooser(state, "down").state;
    state = reduceChooser(state, "down").state;
    expect(state.selectedIndex).toBe(CHOOSER_ITEMS.length - 1);

    const opened = reduceChooser(state, "enter");
    expect(opened.intents).toEqual([{ kind: "open-view", view: "agents" }]);
    expect(opened.state.closed).toBe(true);
    expect(reduceChooser(opened.state, "escape").intents).toEqual([]);

    const closed = reduceChooser(initialChooserState(), "escape");
    expect(closed.intents).toEqual([{ kind: "close" }]);
  });

  it("renders chooser rows within both width and row bounds", () => {
    const lines = chooserLines(initialChooserState(), 18, 2, "bad argument");
    expect(lines).toHaveLength(2);
    expect(() => assertBoundedRender(lines, 18)).not.toThrow();
  });
});

describe("runs reducer", () => {
  it("anchors selection by run id across refreshes", () => {
    let state = initialRunsViewState([run("run-1"), run("run-2")]);
    state = reduceRunsView(state, { kind: "key", action: "down" }).state;
    state = reduceRunsView(state, {
      kind: "runs-updated",
      runs: [run("run-0"), run("run-2"), run("run-3")],
    }).state;
    expect(state.selectedIndex).toBe(1);

    state = reduceRunsView(state, {
      kind: "runs-updated",
      runs: [run("run-0")],
    }).state;
    expect(state.selectedIndex).toBe(0);
  });

  it("opens detail directly, refreshes it, and escapes detail then list", () => {
    let state = initialRunsViewState([run("run-1")]);
    let result = reduceRunsView(state, { kind: "key", action: "enter" });
    expect(result.intents).toEqual([
      { kind: "request-inspection", runId: "run-1" },
    ]);
    state = result.state;

    state = reduceRunsView(state, {
      kind: "inspection-updated",
      inspection: inspection("other"),
    }).state;
    expect(state.detail?.inspection).toBeUndefined();
    state = reduceRunsView(state, {
      kind: "inspection-updated",
      inspection: inspection("run-1"),
    }).state;
    expect(state.detail?.inspection?.id).toBe("run-1");

    result = reduceRunsView(state, { kind: "key", action: "refresh" });
    expect(result.intents).toEqual([
      { kind: "request-inspection", runId: "run-1" },
      { kind: "request-refresh" },
    ]);
    state = result.state;

    result = reduceRunsView(state, { kind: "key", action: "escape" });
    expect(result.state.mode).toBe("list");
    expect(result.state.detail).toBeUndefined();
    result = reduceRunsView(result.state, { kind: "key", action: "escape" });
    expect(result.state.closed).toBe(true);
    expect(result.intents).toEqual([{ kind: "close" }]);
  });

  it("preserves a scrolled transcript position and follows only at the tail", () => {
    let state = reduceRunsView(initialRunsViewState([run("run-1")]), {
      kind: "key",
      action: "enter",
    }).state;
    const first = {
      ...inspection("run-1"),
      transcript: Array.from({ length: 12 }, (_, index) => ({
        kind: "status" as const,
        at: index,
        text: `event ${index}`,
      })),
    };
    state = reduceRunsView(state, { kind: "inspection-updated", inspection: first }).state;
    state = reduceRunsView(state, { kind: "key", action: "page-up" }).state;
    expect(state.detail).toMatchObject({ scrollOffset: 5, tailFollow: false });

    const next = {
      ...first,
      transcript: [...first.transcript, { kind: "status" as const, at: 20, text: "new" }],
    };
    state = reduceRunsView(state, { kind: "inspection-updated", inspection: next }).state;
    expect(state.detail).toMatchObject({ scrollOffset: 6, tailFollow: false });
    state = reduceRunsView(state, { kind: "key", action: "page-down" }).state;
    state = reduceRunsView(state, { kind: "key", action: "page-down" }).state;
    expect(state.detail).toMatchObject({ scrollOffset: 0, tailFollow: true });
  });

  it("confirms active cancellation but never asks for settled runs", () => {
    let state = initialRunsViewState([
      run("run-1"),
      run("run-2", "completed"),
    ]);
    let result = reduceRunsView(state, {
      kind: "key",
      action: "cancel-run",
    });
    expect(result.intents).toEqual([]);
    expect(result.state.pendingCancelId).toBe("run-1");
    state = result.state;

    result = reduceRunsView(state, {
      kind: "cancel-confirmed",
      runId: "run-1",
      confirmed: false,
    });
    expect(result.intents).toEqual([]);
    expect(result.state.pendingCancelId).toBeUndefined();

    result = reduceRunsView(result.state, {
      kind: "key",
      action: "cancel-run",
    });
    result = reduceRunsView(result.state, {
      kind: "cancel-confirmed",
      runId: "run-1",
      confirmed: true,
    });
    expect(result.intents).toEqual([
      { kind: "request-cancel", runId: "run-1" },
      { kind: "request-refresh" },
    ]);

    state = { ...result.state, selectedIndex: 1 };
    result = reduceRunsView(state, {
      kind: "key",
      action: "cancel-run",
    });
    expect(result.intents).toEqual([]);
    expect(result.state.notice).toContain("already completed");
  });
});

describe("runs line models", () => {
  it("keeps the selected run visible in a bounded viewport", () => {
    const runs = Array.from({ length: 20 }, (_, index) =>
      run(`run-${index + 1}`),
    );
    const state = { ...initialRunsViewState(runs), selectedIndex: 10 };
    const lines = runsListLines(state, 32, 4);
    expect(lines).toHaveLength(4);
    expect(lines.some((line) => line.includes("run-11"))).toBe(true);
    expect(() => assertBoundedRender(lines, 32)).not.toThrow();
  });

  it("preserves detail identity while bounding long progress and output", () => {
    const base = initialRunsViewState([run("run-1")]);
    const detail = {
      ...inspection("run-1", "completed"),
      transcript: Array.from({ length: 20 }, (_, index) => ({
        kind: "assistant" as const,
        at: index,
        text: `progress ${index} ${"界".repeat(20)}`,
      })),
      resultPreview: "output ".repeat(100),
    };
    const state = {
      ...base,
      mode: "detail" as const,
      detail: {
        runId: "run-1",
        inspection: detail,
        scrollOffset: 0,
        tailFollow: true,
        submitting: false,
      },
    };
    const lines = runDetailLines(state, 30, 6);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain("run-1");
    expect(lines[1]).toContain("completed");
    expect(() => assertBoundedRender(lines, 30)).not.toThrow();
  });
});
