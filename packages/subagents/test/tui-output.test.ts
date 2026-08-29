import { describe, expect, it } from "vitest";
import type {
  RunInspection,
  RunListEntry,
} from "../src/shared/types.js";
import { assertBoundedRender, RenderBoundsError } from "../src/tui/binding.js";
import type { RoutingAgentRow } from "../src/tui/routing-view.js";
import {
  agentsSummaryText,
  chooserSummaryText,
  runInspectionSummaryText,
  runsSummaryText,
} from "../src/tui/summaries.js";
import { countRuns, statusText, widgetLines } from "../src/tui/status.js";
import {
  fitHeadTailLines,
  fitLine,
  fitLines,
  fitViewport,
  formatElapsed,
  textWidth,
  wrapText,
} from "../src/tui/text.js";

function run(
  id: string,
  status: RunListEntry["status"],
): RunListEntry {
  return {
    id,
    title: `Run ${id} ${"界".repeat(30)}`,
    harness: "claude",
    status,
    elapsedMs: 65_000,
    model: "fable",
  };
}

function inspect(): RunInspection {
  return {
    id: "run-1",
    title: "Long run",
    harness: "pi",
    status: "completed",
    createdAt: 0,
    settledAt: 1,
    elapsedMs: 1,
    cancelRequested: false,
    model: "anthropic/test",
    usage: undefined,
    activity: Array.from({ length: 40 }, (_, index) => ({
      at: index,
      text: `activity ${index} ${"x".repeat(200)}`,
    })),
    activityDropped: 10,
    transcript: [
      { kind: "user", at: 1, text: "Please inspect 界" },
      { kind: "assistant", at: 2, text: "Done 👨‍👩‍👧‍👦" },
      { kind: "tool", at: 3, toolName: "read", phase: "complete", input: "file", output: "result" },
    ],
    transcriptDropped: 10,
    messaging: { supported: true, editable: false, reason: "completed" },
    resultPreview: Array.from({ length: 20 }, () => "界".repeat(100)).join("\n"),
    consumption: "none",
  };
}

function agent(name: string): RoutingAgentRow {
  return {
    name,
    description: "Agent",
    definitionScope: "package",
    route: {
      harness: "pi",
      model: undefined,
      thinking: undefined,
      provenance: {
        harness: "agent-default",
        model: "parent",
        thinking: "parent",
      },
    },
    userEntry: undefined,
    projectEntry: undefined,
  };
}

describe("plain-text bounds", () => {
  it("measures wide and joined graphemes conservatively", () => {
    expect(textWidth("abc")).toBe(3);
    expect(textWidth("界")).toBe(2);
    expect(textWidth("e\u0301")).toBe(1);
    expect(textWidth("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("fits and wraps wide text without exceeding terminal cells", () => {
    const fitted = fitLine("界".repeat(20), 7);
    expect(textWidth(fitted)).toBeLessThanOrEqual(7);

    const wrapped = wrapText("界".repeat(20), 6);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.every((line) => textWidth(line) <= 6)).toBe(true);
    expect(wrapText("abc", 0)).toEqual([]);
  });

  it("bounds tails, selectable viewports, and fixed-header details", () => {
    const source = Array.from({ length: 10 }, (_, index) => `line ${index}`);
    expect(fitLines(source, 20, 3)).toHaveLength(3);

    const viewport = fitViewport(source, 5, 20, 4);
    expect(viewport).toHaveLength(4);
    expect(viewport.some((line) => line === "line 5")).toBe(true);

    const detail = fitHeadTailLines(source, 20, 5, 2);
    expect(detail).toHaveLength(5);
    expect(detail.slice(0, 2)).toEqual(["line 0", "line 1"]);
    expect(detail.at(-1)).toBe("line 9");
  });

  it("asserts visible cell width rather than JavaScript string length", () => {
    expect(() => assertBoundedRender(["界界"], 4)).not.toThrow();
    expect(() => assertBoundedRender(["界界"], 3)).toThrow(RenderBoundsError);
    try {
      assertBoundedRender(["ok", "界界"], 3);
    } catch (error) {
      expect(error).toMatchObject({
        lineIndex: 1,
        lineLength: 4,
        width: 3,
      });
    }
  });

  it("formats elapsed values safely", () => {
    expect(formatElapsed(-1)).toBe("0s");
    expect(formatElapsed(Number.NaN)).toBe("0s");
    expect(formatElapsed(130_000)).toBe("2m10s");
    expect(formatElapsed(3_660_000)).toBe("1h01m");
  });
});

describe("status and widget summaries", () => {
  const runs = [
    run("run-1", "running"),
    run("run-2", "queued"),
    run("run-3", "completed"),
    run("run-4", "failed"),
    run("run-5", "cancelled"),
  ];

  it("counts exact running, completed, and error semantics", () => {
    expect(countRuns(runs)).toEqual({
      running: 2,
      completed: 1,
      error: 2,
    });
  });

  it("persists status after settlement and advertises /subagents", () => {
    expect(statusText([])).toBeUndefined();
    expect(statusText([run("run-1", "completed")])).toBe(
      "● 0 running · ✓ 1 completed · × 0 error · /subagents",
    );
    expect(statusText(runs)).toBe(
      "● 2 running · ✓ 1 completed · × 2 error · /subagents",
    );
  });

  it("shows active runs only and collapses overflow", () => {
    const lines = widgetLines(
      Array.from({ length: 6 }, (_, index) => run(`run-${index}`, "running")),
      { width: 24, maxLines: 3 },
    );
    expect(lines).toHaveLength(3);
    expect(lines?.at(-1)).toContain("more running");
    expect(() => assertBoundedRender(lines ?? [], 24)).not.toThrow();

    expect(
      widgetLines([run("run-1", "completed")], { width: 20, maxLines: 2 }),
    ).toBeUndefined();
    expect(
      widgetLines([run("run-1", "running")], { width: 20, maxLines: 0 }),
    ).toBeUndefined();
  });
});

describe("headless command summaries", () => {
  it("returns concise chooser and empty-state messages", () => {
    expect(chooserSummaryText()).toContain("no interactive UI");
    expect(runsSummaryText([])).toBe("No subagent runs in this session.");
    expect(agentsSummaryText([], true)).toBe("No subagent agents discovered.");
  });

  it("bounds large run and agent catalogs", () => {
    const runSummary = runsSummaryText(
      Array.from({ length: 100 }, (_, index) => run(`run-${index}`, "running")),
    );
    const runLines = runSummary.split("\n");
    expect(runLines.length).toBeLessThanOrEqual(30);
    expect(runLines.at(-1)).toContain("more lines");
    expect(runLines.every((line) => textWidth(line) <= 120)).toBe(true);

    const agentSummary = agentsSummaryText(
      Array.from({ length: 100 }, (_, index) => agent(`agent-${index}`)),
      false,
    );
    const agentLines = agentSummary.split("\n");
    expect(agentLines.length).toBeLessThanOrEqual(30);
    expect(agentLines.every((line) => textWidth(line) <= 120)).toBe(true);
  });

  it("shows thinking after the model in list and detail summaries", () => {
    const listEntry = {
      ...run("run-1", "running"),
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "low" as const,
    };
    const inspection = {
      ...inspect(),
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "low" as const,
    };

    expect(runsSummaryText([listEntry])).toContain("openai-codex/gpt-5.6-sol (low)");
    expect(runInspectionSummaryText(inspection)).toContain(
      "model: openai-codex/gpt-5.6-sol (low)",
    );
    expect(runsSummaryText([run("run-2", "running")])).toContain("· fable ·");
    expect(runsSummaryText([run("run-2", "running")])).not.toContain("fable (");
  });

  it("bounds inspection activity and multiline output", () => {
    const lines = runInspectionSummaryText(inspect()).split("\n");
    expect(lines.length).toBeLessThanOrEqual(30);
    expect(lines.every((line) => textWidth(line) <= 120)).toBe(true);
  });
});
