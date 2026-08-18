import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import type { RoutingAgentRow } from "../src/tui/routing-view.js";
import { initialRoutingViewState } from "../src/tui/routing-view.js";
import {
  renderRoutingEditorPanel,
  renderRoutingPanel,
  renderRunsPanel,
} from "../src/tui/pi-panel-renderer.js";
import {
  createRoutingEditorState,
  ROUTING_EDITOR_KEY_HINTS,
} from "../src/tui/routing-editor.js";
import { ROUTING_KEY_HINTS } from "../src/tui/routing-view.js";
import { FULL_SCREEN_PANEL_OPTIONS } from "../src/tui/pi-views.js";
import {
  initialRunsViewState,
  RUN_DETAIL_KEY_HINTS,
  RUNS_LIST_KEY_HINTS,
} from "../src/tui/runs-view.js";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const theme = {
  fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
  bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  inverse: (text: string) => `\x1b[7m${text}\x1b[27m`,
} as unknown as Theme;

function plain(lines: readonly string[]): string {
  return lines.join("\n").replace(ANSI_PATTERN, "");
}

function expectBounded(lines: readonly string[], width: number, rows: number): void {
  expect(lines.length).toBeLessThanOrEqual(rows);
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function routingRows(): RoutingAgentRow[] {
  return [
    {
      name: "gig-feasibility-reviewer",
      description: "Checks whether a plan is feasible",
      definitionScope: "user",
      route: {
        harness: "claude",
        model: "fable",
        thinking: "high",
        provenance: {
          harness: "saved-user",
          model: "saved-user",
          thinking: "saved-user",
        },
      },
      userEntry: { harness: "claude", model: "fable", thinking: "high" },
      projectEntry: undefined,
    },
    {
      name: "gig-security-reviewer",
      description: "Reviews security",
      definitionScope: "user",
      route: {
        harness: "pi",
        model: "openai-codex/gpt-5.6-sol",
        thinking: "high",
        provenance: {
          harness: "parent",
          model: "parent",
          thinking: "parent",
        },
      },
      userEntry: undefined,
      projectEntry: undefined,
    },
  ];
}

describe("theme-native Pi panel renderer", () => {
  it("uses a zero-margin full-terminal overlay for both panels", () => {
    expect(FULL_SCREEN_PANEL_OPTIONS).toEqual({
      width: "100%",
      maxHeight: "100%",
      anchor: "center",
      margin: 0,
    });
  });

  it("renders routing as a framed, themed, two-level list", () => {
    const state = initialRoutingViewState({
      rows: routingRows(),
      projectTrusted: true,
    });
    const lines = renderRoutingPanel(theme, state, 84, 24, ROUTING_KEY_HINTS);
    const output = plain(lines);

    expectBounded(lines, 84, 24);
    expect(output).toContain("╭─ AGENT ROUTING");
    expect(output).toContain("USER");
    expect(output).toContain("2 agents  ·  1 saved here  ·  ◆ mapped");
    expect(output).toContain("▸ ◆ gig-feasibility-reviewer");
    expect(output).toContain("user  ·  fable  ·  high");
    expect(output).toContain("H:user M:user T:user");
    expect(output).toContain("↑↓ move");
    expect(output).toContain("╰");
    expect(lines.some((line) => line.includes("\x1b[44m"))).toBe(true);
  });

  it("fills the terminal height so the overlay is genuinely full-screen", () => {
    const state = initialRoutingViewState({
      rows: routingRows(),
      projectTrusted: true,
    });
    const lines = renderRoutingPanel(theme, state, 84, 32, ROUTING_KEY_HINTS);

    expect(lines).toHaveLength(32);
    expect(plain(lines[30] ? [lines[30]] : [])).toContain("↑↓ move");
    expect(plain(lines[31] ? [lines[31]] : [])).toContain("╰");
  });

  it("renders route editing inside the same full-screen panel", () => {
    const editor = createRoutingEditorState({
      agentName: "gig-feasibility-reviewer",
      scope: "project",
      current: { harness: "claude", model: "fable", thinking: "high" },
    });
    const lines = renderRoutingEditorPanel(theme, editor, 84, 28, ROUTING_EDITOR_KEY_HINTS);
    const output = plain(lines);

    expectBounded(lines, 84, 28);
    expect(lines).toHaveLength(28);
    expect(output).toContain("EDIT AGENT ROUTE");
    expect(output).toContain("gig-feasibility-reviewer");
    expect(output).toContain("PROJECT MAPPING");
    expect(output).toContain("01  HARNESS");
    expect(output).toContain("02  MODEL");
    expect(output).toContain("03  THINKING");
    expect(output).toContain("enter save");
  });

  it("keeps long routing values inside narrow terminals", () => {
    const rows = routingRows();
    rows[0] = { ...rows[0]!, name: "agent-with-an-intentionally-extremely-long-name-that-must-be-clipped" };
    const state = initialRoutingViewState({ rows, projectTrusted: false });
    const lines = renderRoutingPanel(theme, state, 40, 18, ROUTING_KEY_HINTS);

    expectBounded(lines, 40, 18);
    expect(plain(lines)).toContain("PROJECT · UNTRUSTED");
  });

  it("renders run status, hierarchy, and an actionable empty state", () => {
    const empty = renderRunsPanel(
      theme,
      initialRunsViewState(),
      72,
      24,
      RUNS_LIST_KEY_HINTS,
      RUN_DETAIL_KEY_HINTS,
    );
    expect(plain(empty)).toContain("No runs yet");

    const state = initialRunsViewState([
      {
        id: "run-3",
        title: "Review the authentication boundary",
        harness: "claude",
        status: "running",
        elapsedMs: 12_500,
        model: "fable",
      },
      {
        id: "run-2",
        title: "Map package resources",
        harness: "pi",
        status: "completed",
        elapsedMs: 4_000,
        model: "openai-codex/gpt-5.6-sol",
      },
    ]);
    const lines = renderRunsPanel(theme, state, 72, 24, RUNS_LIST_KEY_HINTS, RUN_DETAIL_KEY_HINTS);
    const output = plain(lines);

    expectBounded(lines, 72, 24);
    expect(output).toContain("╭─ SUBAGENT RUNS");
    expect(output).toContain("1 running");
    expect(output).toContain("▸ ● run-3");
    expect(output).toContain("CLAUDE  ·  fable");
    expect(output).toContain("RUNNING  12s");
  });

  it("renders inspection activity and output as separate visual sections", () => {
    const base = initialRunsViewState([
      {
        id: "run-1",
        title: "Inspect release behavior",
        harness: "pi",
        status: "completed",
        elapsedMs: 2_000,
        model: "openai-codex/gpt-5.6-sol",
      },
    ]);
    const state = {
      ...base,
      mode: "detail" as const,
      detail: {
        runId: "run-1",
        takeover: false,
        inspection: {
          id: "run-1",
          title: "Inspect release behavior",
          harness: "pi" as const,
          status: "completed" as const,
          createdAt: 0,
          settledAt: 2_000,
          elapsedMs: 2_000,
          cancelRequested: false,
          model: "openai-codex/gpt-5.6-sol",
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            costUsd: 0.0123,
            turns: 2,
            contextTokens: 150,
          },
          activity: [
            { at: 500, text: "Reading package manifests" },
            { at: 1_000, text: "Checking release workflow" },
          ],
          activityDropped: 0,
          resultPreview: "Publishing remains disabled.",
          consumption: "none" as const,
        },
      },
    };
    const lines = renderRunsPanel(theme, state, 78, 24, RUNS_LIST_KEY_HINTS, RUN_DETAIL_KEY_HINTS);
    const output = plain(lines);

    expectBounded(lines, 78, 24);
    expect(output).toContain("ACTIVITY");
    expect(output).toContain("Reading package manifests");
    expect(output).toContain("OUTPUT");
    expect(output).toContain("Publishing remains disabled.");
    expect(output).toContain("2 turns  ·  150 tokens  ·  $0.0123");
  });

  it("never violates the component contract at tiny widths", () => {
    const lines = renderRunsPanel(
      theme,
      initialRunsViewState(),
      3,
      5,
      RUNS_LIST_KEY_HINTS,
      RUN_DETAIL_KEY_HINTS,
    );
    expectBounded(lines, 3, 5);
  });
});
