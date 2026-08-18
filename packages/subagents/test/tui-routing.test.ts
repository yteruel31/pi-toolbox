import { describe, expect, it } from "vitest";
import type { RoutingEntry } from "../src/agents/types.js";
import { assertBoundedRender } from "../src/tui/binding.js";
import {
  initialRoutingViewState,
  normalizeRoutingEntry,
  reduceRoutingView,
  routingListLines,
} from "../src/tui/routing-view.js";
import type { RoutingAgentRow } from "../src/tui/routing-view.js";

function row(
  name: string,
  entries: {
    user?: RoutingEntry;
    project?: RoutingEntry;
  } = {},
): RoutingAgentRow {
  return {
    name,
    description: `Description for ${name}`,
    definitionScope: "user",
    route: {
      harness: "pi",
      model: "anthropic/test",
      thinking: "high",
      provenance: {
        harness: "parent",
        model: "parent",
        thinking: "parent",
      },
    },
    userEntry: entries.user,
    projectEntry: entries.project,
  };
}

describe("routing reducer", () => {
  it("navigates rows and preserves the selected agent across refreshes", () => {
    let state = initialRoutingViewState({
      projectTrusted: true,
      rows: [row("alpha"), row("beta")],
    });
    state = reduceRoutingView(state, {
      kind: "key",
      action: "down",
    }).state;
    state = reduceRoutingView(state, {
      kind: "rows-updated",
      rows: [row("gamma"), row("beta"), row("delta")],
    }).state;
    expect(state.selectedIndex).toBe(1);

    state = reduceRoutingView(state, {
      kind: "rows-updated",
      rows: [row("gamma")],
    }).state;
    expect(state.selectedIndex).toBe(0);
  });

  it("toggles mapping scope only for trusted projects", () => {
    let trusted = initialRoutingViewState({ projectTrusted: true });
    trusted = reduceRoutingView(trusted, {
      kind: "key",
      action: "tab",
    }).state;
    expect(trusted.scope).toBe("project");
    trusted = reduceRoutingView(trusted, {
      kind: "key",
      action: "tab",
    }).state;
    expect(trusted.scope).toBe("user");

    const untrusted = reduceRoutingView(
      initialRoutingViewState({ projectTrusted: false }),
      { kind: "key", action: "tab" },
    );
    expect(untrusted.state.scope).toBe("user");
    expect(untrusted.state.notice).toContain("untrusted");
  });

  it("opens and commits an editor for the selected scope", () => {
    const current = { harness: "claude" as const, model: "opus" };
    let state = initialRoutingViewState({
      projectTrusted: true,
      rows: [row("reviewer", { user: current })],
    });
    let result = reduceRoutingView(state, { kind: "key", action: "enter" });
    expect(result.state.editing).toEqual({
      agentName: "reviewer",
      scope: "user",
      current,
    });
    expect(result.intents).toEqual([
      { kind: "open-editor", session: result.state.editing },
    ]);

    state = result.state;
    expect(
      reduceRoutingView(state, { kind: "key", action: "down" }).state,
    ).toBe(state);

    result = reduceRoutingView(state, {
      kind: "edit-committed",
      entry: { harness: "pi", model: "  model-id  ", thinking: "low" },
    });
    expect(result.state.editing).toBeUndefined();
    expect(result.intents).toEqual([
      {
        kind: "save-mapping",
        scope: "user",
        agentName: "reviewer",
        entry: { harness: "pi", model: "model-id", thinking: "low" },
      },
    ]);
  });

  it("deletes only an existing mapping in the selected scope", () => {
    const initial = initialRoutingViewState({
      projectTrusted: true,
      rows: [row("reviewer", { user: { model: "opus" } })],
    });
    let result = reduceRoutingView(initial, {
      kind: "key",
      action: "delete-mapping",
    });
    expect(result.intents).toEqual([
      { kind: "delete-mapping", scope: "user", agentName: "reviewer" },
    ]);

    const noMapping = {
      ...initial,
      rows: [row("reviewer")],
    };
    result = reduceRoutingView(noMapping, {
      kind: "key",
      action: "delete-mapping",
    });
    expect(result.intents).toEqual([]);
    expect(result.state.notice).toContain("No user mapping");
  });

  it("requires explicit backup/reset before mutating an invalid file", () => {
    let state = initialRoutingViewState({
      projectTrusted: true,
      rows: [row("reviewer")],
      invalid: { user: "invalid JSON" },
    });
    let result = reduceRoutingView(state, { kind: "key", action: "enter" });
    expect(result.state.pendingReset).toBe("user");
    expect(result.intents).toEqual([
      { kind: "confirm-reset", scope: "user", reason: "invalid JSON" },
    ]);

    state = result.state;
    expect(
      reduceRoutingView(state, { kind: "key", action: "down" }).state,
    ).toBe(state);

    result = reduceRoutingView(state, {
      kind: "reset-confirmed",
      scope: "user",
      confirmed: true,
    });
    expect(result.state.pendingReset).toBeUndefined();
    expect(result.state.resettingScope).toBe("user");
    expect(result.intents).toEqual([
      { kind: "backup-and-reset", scope: "user" },
    ]);

    state = result.state;
    const stale = reduceRoutingView(state, {
      kind: "reset-done",
      scope: "project",
      backupPath: "/tmp/project.backup",
    });
    expect(stale.state).toBe(state);

    result = reduceRoutingView(state, {
      kind: "reset-done",
      scope: "user",
      backupPath: "/tmp/user.backup",
    });
    expect(result.state.invalid.user).toBeUndefined();
    expect(result.state.resettingScope).toBeUndefined();
    expect(result.state.notice).toContain("/tmp/user.backup");
    expect(result.intents).toEqual([{ kind: "request-refresh" }]);
  });

  it("can decline reset or dismiss its pending confirmation with escape", () => {
    const pending = {
      ...initialRoutingViewState({ projectTrusted: true }),
      pendingReset: "user" as const,
    };
    const declined = reduceRoutingView(pending, {
      kind: "reset-confirmed",
      scope: "user",
      confirmed: false,
    });
    expect(declined.state.pendingReset).toBeUndefined();
    expect(declined.intents).toEqual([]);

    const escaped = reduceRoutingView(pending, {
      kind: "key",
      action: "escape",
    });
    expect(escaped.state.pendingReset).toBeUndefined();
    expect(escaped.state.closed).toBe(false);
  });

  it("closes once and ignores later events", () => {
    const closed = reduceRoutingView(
      initialRoutingViewState({ projectTrusted: true }),
      { kind: "key", action: "escape" },
    );
    expect(closed.intents).toEqual([{ kind: "close" }]);
    expect(
      reduceRoutingView(closed.state, {
        kind: "rows-updated",
        rows: [row("late")],
      }).state,
    ).toBe(closed.state);
  });
});

describe("routing entry and rendering contracts", () => {
  it("normalizes adapter-owned editor values before persistence", () => {
    expect(normalizeRoutingEntry({ model: "   " })).toEqual({});
    expect(
      normalizeRoutingEntry({ harness: "claude", model: " fable ", thinking: "max" }),
    ).toEqual({ harness: "claude", model: "fable", thinking: "max" });
  });

  it("keeps the selected agent visible and every line bounded", () => {
    const rows = Array.from({ length: 20 }, (_, index) =>
      row(`agent-${index + 1}`),
    );
    const state = {
      ...initialRoutingViewState({ projectTrusted: false, rows }),
      selectedIndex: 12,
    };
    const lines = routingListLines(state, 36, 5);
    expect(lines).toHaveLength(5);
    expect(lines.some((line) => line.includes("agent-13"))).toBe(true);
    expect(() => assertBoundedRender(lines, 36)).not.toThrow();
  });

  it("shows invalid-file guidance without exceeding row bounds", () => {
    const state = initialRoutingViewState({
      projectTrusted: true,
      rows: [row("reviewer")],
      invalid: { user: "x".repeat(500) },
    });
    const lines = routingListLines(state, 24, 3);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes("invalid"))).toBe(true);
    expect(() => assertBoundedRender(lines, 24)).not.toThrow();
  });
});
