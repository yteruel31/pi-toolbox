import {
  createSubscriptionBag,
  createViewStore,
} from "./binding.js";
import type {
  RoutingDataPort,
  RunsDataPort,
  ViewStore,
} from "./binding.js";
import {
  initialRoutingViewState,
  reduceRoutingView,
} from "./routing-view.js";
import type {
  RoutingViewEvent,
  RoutingViewIntent,
  RoutingViewState,
} from "./routing-view.js";
import {
  initialRunsViewState,
  reduceRunsView,
} from "./runs-view.js";
import type {
  RunsViewEvent,
  RunsViewIntent,
  RunsViewState,
} from "./runs-view.js";

export interface RunsViewModel extends ViewStore<RunsViewState, RunsViewEvent> {
  /** Pull both the run list and the open detail, if any, from the port. */
  refresh(): void;
  /** Submit through the active run; false means rejected or disposed. */
  submitMessage(text: string): Promise<boolean>;
}

export interface RunsViewModelOptions {
  data: RunsDataPort;
  onIntent?(intent: RunsViewIntent): void;
  onChange?(state: RunsViewState): void;
}

/**
 * Connect the runs reducer to a live data port without importing Pi. Closing
 * or disposing the model releases its subscription exactly once.
 */
export function createRunsViewModel(
  options: RunsViewModelOptions,
): RunsViewModel {
  const subscriptions = createSubscriptionBag();
  let disposed = false;
  let store: ViewStore<RunsViewState, RunsViewEvent>;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    store.dispose();
    subscriptions.dispose();
  };

  const refresh = () => {
    if (disposed) return;
    store.dispatch({ kind: "runs-updated", runs: options.data.list() });
    const detail = store.getState().detail;
    if (!detail) return;
    const inspection = options.data.inspect(detail.runId);
    if (inspection) {
      store.dispatch({ kind: "inspection-updated", inspection });
    }
  };

  store = createViewStore({
    initialState: initialRunsViewState(options.data.list()),
    reduce: reduceRunsView,
    onChange: options.onChange,
    onIntent(intent) {
      switch (intent.kind) {
        case "request-refresh":
          refresh();
          return;
        case "request-inspection": {
          const inspection = options.data.inspect(intent.runId);
          if (inspection) {
            store.dispatch({ kind: "inspection-updated", inspection });
          }
          return;
        }
        case "request-cancel":
          options.data.cancel(intent.runId);
          return;
        case "close":
          options.onIntent?.(intent);
          dispose();
          return;
        case "confirm-cancel":
          options.onIntent?.(intent);
      }
    },
  });

  const submitMessage = async (text: string): Promise<boolean> => {
    if (disposed) return false;
    const detail = store.getState().detail;
    if (!detail || detail.submitting) return false;
    const runId = detail.runId;
    store.dispatch({ kind: "submission-started", runId });
    try {
      await options.data.sendMessage(runId, text);
      if (disposed) return false;
      store.dispatch({ kind: "submission-finished", runId });
      refresh();
      return true;
    } catch (error) {
      if (!disposed) {
        store.dispatch({
          kind: "submission-finished",
          runId,
          error: error instanceof Error ? error.message : String(error),
        });
        refresh();
      }
      return false;
    }
  };

  subscriptions.add(options.data.subscribe(refresh));

  return {
    get disposed() {
      return disposed;
    },
    getState: store.getState,
    dispatch: store.dispatch,
    refresh,
    submitMessage,
    dispose,
  };
}

export interface RoutingViewModel
  extends ViewStore<RoutingViewState, RoutingViewEvent> {
  /** Refresh agent rows. Older overlapping refresh results are ignored. */
  refresh(): Promise<void>;
}

export interface RoutingViewModelOptions {
  data: RoutingDataPort;
  projectTrusted: boolean;
  onIntent?(intent: RoutingViewIntent): void;
  onChange?(state: RoutingViewState): void;
  onError?(error: unknown): void;
  loadImmediately?: boolean;
}

/** Connect the routing reducer to async storage while suppressing late work. */
export function createRoutingViewModel(
  options: RoutingViewModelOptions,
): RoutingViewModel {
  let disposed = false;
  let refreshSerial = 0;
  let operationChain = Promise.resolve();
  let store: ViewStore<RoutingViewState, RoutingViewEvent>;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    refreshSerial += 1;
    store.dispose();
  };

  const fail = (message: string, error: unknown) => {
    if (disposed) return;
    options.onError?.(error);
    store.dispatch({ kind: "operation-failed", message });
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    const serial = ++refreshSerial;
    try {
      const result = await options.data.rows();
      if (disposed || serial !== refreshSerial) return;
      store.dispatch({
        kind: "rows-updated",
        rows: result.rows,
        invalid: result.invalid,
      });
    } catch (error) {
      if (disposed || serial !== refreshSerial) return;
      fail("Could not load subagent routing.", error);
    }
  };

  const enqueue = (operation: () => Promise<void>) => {
    operationChain = operationChain.then(operation, operation);
    // The operation catches its own errors; this observes the chain anyway.
    void operationChain.catch(() => undefined);
  };

  store = createViewStore({
    initialState: initialRoutingViewState({
      projectTrusted: options.projectTrusted,
    }),
    reduce: reduceRoutingView,
    onChange: options.onChange,
    onIntent(intent) {
      switch (intent.kind) {
        case "request-refresh":
          void refresh();
          return;
        case "save-mapping":
          enqueue(async () => {
            try {
              await options.data.saveMapping(
                intent.scope,
                intent.agentName,
                intent.entry,
              );
              await refresh();
            } catch (error) {
              fail("Could not save subagent routing.", error);
            }
          });
          return;
        case "delete-mapping":
          enqueue(async () => {
            try {
              await options.data.deleteMapping(intent.scope, intent.agentName);
              await refresh();
            } catch (error) {
              fail("Could not delete subagent routing.", error);
            }
          });
          return;
        case "backup-and-reset":
          enqueue(async () => {
            try {
              const backupPath = await options.data.backupAndReset(intent.scope);
              if (!disposed) {
                store.dispatch({
                  kind: "reset-done",
                  scope: intent.scope,
                  backupPath,
                });
              }
            } catch (error) {
              fail("Could not back up and reset subagent routing.", error);
            }
          });
          return;
        case "close":
          options.onIntent?.(intent);
          dispose();
          return;
        case "open-editor":
        case "confirm-reset":
          options.onIntent?.(intent);
      }
    },
  });

  if (options.loadImmediately !== false) void refresh();

  return {
    get disposed() {
      return disposed;
    },
    getState: store.getState,
    dispatch: store.dispatch,
    refresh,
    dispose,
  };
}
