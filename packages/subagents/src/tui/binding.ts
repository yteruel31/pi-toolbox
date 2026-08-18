/**
 * Binding contracts between the pure view layer and Pi's TUI. Concrete
 * adapters implement these against ctx.ui.custom()/overlays; nothing in
 * this file imports Pi. The contracts encode the rules the reducers cannot
 * enforce alone:
 *
 * - bounded render: every rendered line fits the given width;
 * - disposal: a closed view stops reacting and releases every subscription
 *   exactly once (overlay components are disposed on close and never reused);
 * - data flows in through ports the binding can subscribe to, so live run
 *   updates re-render without the reducers polling anything.
 */

import type { RunInspection, RunListEntry } from "../shared/types.js";
import type {
  RoutingEntry,
  RoutingScope,
} from "../agents/types.js";
import type { RoutingAgentRow, RoutingInvalidState } from "./routing-view.js";
import { textWidth } from "./text.js";

/** Something holding resources that must be released exactly once. */
export interface Disposable {
  dispose(): void;
}

/** Subscription handle; calling it more than once must be a no-op. */
export type Unsubscribe = () => void;

/**
 * Structural mirror of the pi-tui Component contract, minus everything we
 * don't need. A concrete view object satisfies both this and pi-tui's
 * Component. `render(width)` must return lines whose visible width is <=
 * `width`; `handleInput` receives raw key data; `invalidate` clears caches.
 */
export interface TuiComponentLike {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate(): void;
}

/** A bound view: a component that also honors the disposal contract. */
export interface BoundView extends TuiComponentLike, Disposable {}

/**
 * Read/subscribe port over live run data. The concrete adapter implements it
 * on top of RunManager plus a change-notification hook; tests implement it
 * with arrays. `subscribe` must return an idempotent unsubscribe, and the
 * binding must call it on dispose.
 */
export interface RunsDataPort {
  list(): RunListEntry[];
  inspect(runId: string): RunInspection | undefined;
  /** Fire-and-forget cancellation intent; idempotent for settled runs. */
  cancel(runId: string): void;
  subscribe(listener: () => void): Unsubscribe;
}

/**
 * Mutation port for the routing editor. All writes are atomic and
 * permission-restricted per SPEC; `backupInvalid` is the explicit
 * backup/reset action required before overwriting an invalid file.
 */
export interface RoutingDataPort {
  rows(): Promise<{ rows: RoutingAgentRow[]; invalid: RoutingInvalidState }>;
  saveMapping(
    scope: RoutingScope,
    agentName: string,
    entry: RoutingEntry,
  ): Promise<void>;
  deleteMapping(scope: RoutingScope, agentName: string): Promise<void>;
  /** Back up the invalid file, write a fresh one, return the backup path. */
  backupAndReset(scope: RoutingScope): Promise<string>;
}

/**
 * Thrown by assertBoundedRender when a line exceeds the requested width.
 * Bindings run this in development/tests to keep the Component contract
 * ("each line MUST fit in width") honest for plain-text lines.
 */
export class RenderBoundsError extends Error {
  constructor(
    readonly lineIndex: number,
    readonly lineLength: number,
    readonly width: number,
  ) {
    super(
      `rendered line ${lineIndex} is ${lineLength} cells, exceeding width ${width}`,
    );
    this.name = "RenderBoundsError";
  }
}

/** Assert every plain-text line fits `width`; returns the lines unchanged. */
export function assertBoundedRender(
  lines: readonly string[],
  width: number,
): readonly string[] {
  lines.forEach((line, index) => {
    const lineLength = textWidth(line);
    if (lineLength > width) {
      throw new RenderBoundsError(index, lineLength, width);
    }
  });
  return lines;
}

/** Reducer step shape shared by all views in this package. */
export interface Step<S, I> {
  state: S;
  intents: I[];
}

export interface ViewStoreOptions<S, E, I> {
  initialState: S;
  reduce(state: S, event: E): Step<S, I>;
  /** Receives every intent, in order, after the state has advanced. */
  onIntent(intent: I): void;
  /** Called after every state change (bind to tui.requestRender()). */
  onChange?(state: S): void;
}

export interface ViewStore<S, E> extends Disposable {
  getState(): S;
  /** No-op after dispose; a disposed view must stop reacting. */
  dispatch(event: E): void;
  readonly disposed: boolean;
}

/**
 * Tiny synchronous store gluing a pure reducer to the outside world. It
 * owns the disposal contract: dispose() is idempotent, and afterwards
 * dispatch neither mutates state nor emits intents or change notifications.
 */
export function createViewStore<S, E, I>(
  options: ViewStoreOptions<S, E, I>,
): ViewStore<S, E> {
  let state = options.initialState;
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    getState: () => state,
    dispatch(event: E) {
      if (disposed) return;
      const step = options.reduce(state, event);
      const changed = step.state !== state;
      state = step.state;
      for (const intent of step.intents) {
        if (disposed) break;
        options.onIntent(intent);
      }
      if (!disposed && changed) options.onChange?.(state);
    },
    dispose() {
      disposed = true;
    },
  };
}

/**
 * Track unsubscribe callbacks and run each exactly once on dispose. Bindings
 * add their RunsDataPort subscription, footer listeners, and timers here so
 * close/dispose can never leak or double-release.
 */
export function createSubscriptionBag(): Disposable & {
  add(unsubscribe: Unsubscribe): void;
  readonly size: number;
} {
  let subs: Unsubscribe[] | undefined = [];
  return {
    add(unsubscribe: Unsubscribe) {
      if (subs === undefined) {
        // Already disposed: release immediately rather than leaking.
        unsubscribe();
        return;
      }
      subs.push(unsubscribe);
    },
    get size() {
      return subs?.length ?? 0;
    },
    dispose() {
      if (subs === undefined) return;
      const toRelease = subs;
      subs = undefined;
      for (const unsubscribe of toRelease) {
        try {
          unsubscribe();
        } catch {
          // Cleanup is best-effort, but one broken callback must not leak the rest.
        }
      }
    },
  };
}
