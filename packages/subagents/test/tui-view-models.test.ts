import { describe, expect, it, vi } from "vitest";
import type {
  RoutingEntry,
  RoutingScope,
} from "../src/agents/types.js";
import type {
  RunInspection,
  RunListEntry,
} from "../src/shared/types.js";
import {
  createSubscriptionBag,
  createViewStore,
} from "../src/tui/binding.js";
import type {
  RoutingDataPort,
  RunsDataPort,
} from "../src/tui/binding.js";
import type {
  RoutingAgentRow,
  RoutingInvalidState,
  RoutingViewIntent,
} from "../src/tui/routing-view.js";
import type { RunsViewIntent } from "../src/tui/runs-view.js";
import {
  createRoutingViewModel,
  createRunsViewModel,
} from "../src/tui/view-models.js";

function run(id: string): RunListEntry {
  return {
    id,
    title: id,
    harness: "pi",
    status: "running",
    elapsedMs: 0,
    model: undefined,
  };
}

function inspection(id: string): RunInspection {
  return {
    id,
    title: id,
    harness: "pi",
    status: "running",
    createdAt: 0,
    settledAt: undefined,
    elapsedMs: 0,
    cancelRequested: false,
    model: undefined,
    usage: undefined,
    activity: [],
    activityDropped: 0,
    transcript: [],
    transcriptDropped: 0,
    messaging: { supported: true, editable: true },
    resultPreview: undefined,
    consumption: "none",
  };
}

function routingRow(name: string, userEntry?: RoutingEntry): RoutingAgentRow {
  return {
    name,
    description: name,
    definitionScope: "user",
    route: {
      harness: "pi",
      model: undefined,
      thinking: undefined,
      provenance: {
        harness: "parent",
        model: "parent",
        thinking: "parent",
      },
    },
    userEntry,
    projectEntry: undefined,
  };
}

describe("generic view binding contracts", () => {
  it("advances state before ordered intents and notifies only on changes", () => {
    const observations: string[] = [];
    const store = createViewStore({
      initialState: 0,
      reduce(state: number, event: "change" | "same") {
        return event === "change"
          ? { state: state + 1, intents: ["first", "second"] }
          : { state, intents: [] };
      },
      onIntent(intent) {
        observations.push(`${intent}:${store.getState()}`);
      },
      onChange(state) {
        observations.push(`changed:${state}`);
      },
    });

    store.dispatch("same");
    expect(observations).toEqual([]);
    store.dispatch("change");
    expect(observations).toEqual(["first:1", "second:1", "changed:1"]);

    store.dispose();
    store.dispose();
    store.dispatch("change");
    expect(store.getState()).toBe(1);
  });

  it("releases every subscription once, even if one cleanup throws", () => {
    const calls: string[] = [];
    const bag = createSubscriptionBag();
    bag.add(() => {
      calls.push("first");
      throw new Error("cleanup failed");
    });
    bag.add(() => calls.push("second"));
    expect(bag.size).toBe(2);

    expect(() => bag.dispose()).not.toThrow();
    bag.dispose();
    expect(calls).toEqual(["first", "second"]);
    expect(bag.size).toBe(0);

    bag.add(() => calls.push("late"));
    expect(calls).toEqual(["first", "second", "late"]);
  });
});

describe("runs view model", () => {
  it("subscribes to live data, drives reducer intents, and disposes on close", () => {
    let runs = [run("run-1")];
    let listener: (() => void) | undefined;
    let unsubscribeCalls = 0;
    const cancelled: string[] = [];
    const port: RunsDataPort = {
      list: () => runs,
      inspect: (id) => inspection(id),
      sendMessage: async () => undefined,
      cancel: (id) => cancelled.push(id),
      subscribe(next) {
        listener = next;
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          unsubscribeCalls += 1;
        };
      },
    };
    const intents: RunsViewIntent[] = [];
    const model = createRunsViewModel({
      data: port,
      onIntent: (intent) => intents.push(intent),
    });

    expect(model.getState().runs).toEqual(runs);
    model.dispatch({ kind: "key", action: "enter" });
    expect(model.getState().detail?.inspection?.id).toBe("run-1");

    runs = [run("run-1"), run("run-2")];
    listener?.();
    expect(model.getState().runs).toHaveLength(2);

    model.dispatch({ kind: "key", action: "cancel-run" });
    expect(model.getState().pendingCancelId).toBe("run-1");
    model.dispatch({
      kind: "cancel-confirmed",
      runId: "run-1",
      confirmed: true,
    });
    expect(cancelled).toEqual(["run-1"]);

    model.dispatch({ kind: "key", action: "escape" });
    model.dispatch({ kind: "key", action: "escape" });
    expect(model.disposed).toBe(true);
    expect(unsubscribeCalls).toBe(1);
    expect(intents.at(-1)).toEqual({ kind: "close" });

    const closedState = model.getState();
    listener?.();
    model.dispose();
    expect(model.getState()).toBe(closedState);
    expect(unsubscribeCalls).toBe(1);
  });

  it("does not mutate disposed UI after a late message submission settles", async () => {
    let resolveSend!: () => void;
    const port: RunsDataPort = {
      list: () => [run("run-1")],
      inspect: (id) => inspection(id),
      sendMessage: () => new Promise<void>((resolve) => { resolveSend = resolve; }),
      cancel: () => undefined,
      subscribe: () => () => undefined,
    };
    const model = createRunsViewModel({ data: port });
    model.dispatch({ kind: "key", action: "enter" });
    const pending = model.submitMessage("continue");
    expect(model.getState().detail?.submitting).toBe(true);
    model.dispose();
    const disposedState = model.getState();
    resolveSend();
    await expect(pending).resolves.toBe(false);
    expect(model.getState()).toBe(disposedState);
  });
});

describe("routing view model", () => {
  it("loads rows, serializes saves, and refreshes after persistence", async () => {
    let rows = [routingRow("reviewer")];
    const saves: Array<{
      scope: RoutingScope;
      agentName: string;
      entry: RoutingEntry;
    }> = [];
    const port: RoutingDataPort = {
      rows: async () => ({ rows, invalid: {} }),
      saveMapping: async (scope, agentName, entry) => {
        saves.push({ scope, agentName, entry });
        rows = [routingRow(agentName, entry)];
      },
      deleteMapping: async () => undefined,
      backupAndReset: async () => "/tmp/backup",
    };
    const intents: RoutingViewIntent[] = [];
    const model = createRoutingViewModel({
      data: port,
      projectTrusted: true,
      loadImmediately: false,
      onIntent: (intent) => intents.push(intent),
    });

    await model.refresh();
    expect(model.getState().rows[0]?.name).toBe("reviewer");
    model.dispatch({ kind: "key", action: "enter" });
    expect(intents.at(-1)?.kind).toBe("open-editor");
    model.dispatch({
      kind: "edit-committed",
      entry: { harness: "claude", model: "fable", thinking: "high" },
    });

    await vi.waitFor(() => {
      expect(saves).toHaveLength(1);
      expect(model.getState().rows[0]?.userEntry).toEqual({
        harness: "claude",
        model: "fable",
        thinking: "high",
      });
    });
  });

  it("backs up invalid routing only after confirmation", async () => {
    let invalid: RoutingInvalidState = { user: "invalid JSON" };
    const backups: RoutingScope[] = [];
    const port: RoutingDataPort = {
      rows: async () => ({ rows: [routingRow("reviewer")], invalid }),
      saveMapping: async () => undefined,
      deleteMapping: async () => undefined,
      backupAndReset: async (scope) => {
        backups.push(scope);
        invalid = {};
        return "/tmp/subagents.json.backup";
      },
    };
    const intents: RoutingViewIntent[] = [];
    const model = createRoutingViewModel({
      data: port,
      projectTrusted: true,
      loadImmediately: false,
      onIntent: (intent) => intents.push(intent),
    });
    await model.refresh();

    model.dispatch({ kind: "key", action: "enter" });
    expect(intents.at(-1)?.kind).toBe("confirm-reset");
    expect(backups).toEqual([]);
    model.dispatch({
      kind: "reset-confirmed",
      scope: "user",
      confirmed: true,
    });

    await vi.waitFor(() => {
      expect(backups).toEqual(["user"]);
      expect(model.getState().invalid.user).toBeUndefined();
      expect(model.getState().notice).toContain("backed up");
    });
  });

  it("ignores stale refreshes and all async results after disposal", async () => {
    let resolveFirst: ((value: {
      rows: RoutingAgentRow[];
      invalid: {};
    }) => void) | undefined;
    const first = new Promise<{
      rows: RoutingAgentRow[];
      invalid: {};
    }>((resolve) => {
      resolveFirst = resolve;
    });
    let call = 0;
    const port: RoutingDataPort = {
      rows: async () => {
        call += 1;
        return call === 1
          ? first
          : { rows: [routingRow("newer")], invalid: {} };
      },
      saveMapping: async () => undefined,
      deleteMapping: async () => undefined,
      backupAndReset: async () => "/tmp/backup",
    };
    const model = createRoutingViewModel({
      data: port,
      projectTrusted: true,
      loadImmediately: false,
    });

    const stale = model.refresh();
    await model.refresh();
    expect(model.getState().rows[0]?.name).toBe("newer");
    resolveFirst?.({ rows: [routingRow("stale")], invalid: {} });
    await stale;
    expect(model.getState().rows[0]?.name).toBe("newer");

    const before = model.getState();
    model.dispose();
    await model.refresh();
    expect(model.getState()).toBe(before);
  });

  it("reports bounded generic operation failures without leaking thrown text", async () => {
    const errors: unknown[] = [];
    const port: RoutingDataPort = {
      rows: async () => {
        throw new Error("secret backend detail");
      },
      saveMapping: async () => undefined,
      deleteMapping: async () => undefined,
      backupAndReset: async () => "/tmp/backup",
    };
    const model = createRoutingViewModel({
      data: port,
      projectTrusted: true,
      loadImmediately: false,
      onError: (error) => errors.push(error),
    });

    await model.refresh();
    expect(errors).toHaveLength(1);
    expect(model.getState().notice).toBe("Could not load subagent routing.");
    expect(model.getState().notice).not.toContain("secret");
  });

  it("disposes immediately when the routing view closes", () => {
    const onIntent = vi.fn();
    const model = createRoutingViewModel({
      data: {
        rows: async () => ({ rows: [], invalid: {} }),
        saveMapping: async () => undefined,
        deleteMapping: async () => undefined,
        backupAndReset: async () => "/tmp/backup",
      },
      projectTrusted: false,
      loadImmediately: false,
      onIntent,
    });
    model.dispatch({ kind: "key", action: "escape" });
    expect(onIntent).toHaveBeenCalledWith({ kind: "close" });
    expect(model.disposed).toBe(true);
  });
});
