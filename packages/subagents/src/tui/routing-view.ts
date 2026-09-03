/**
 * Agent routing editor: resolved agents with effective routes, a user/project
 * mapping scope, and the SPEC keyboard map (arrows navigate, Tab scope,
 * Enter edit, `d` delete mapping, Esc close).
 *
 * Two gates the reducer owns:
 * - Trust: project scope is not editable (or even selectable) when the
 *   project is untrusted, because untrusted project routing is ignored.
 * - Invalid file: when a scope's subagents.json is invalid, any mutation in
 *   that scope first requires the explicit backup/reset flow; nothing is
 *   overwritten silently.
 *
 * The actual field editor (harness/model/thinking picker) is an adapter
 * component; the reducer only opens/closes an edit session and turns the
 * committed entry into a save intent.
 */

import type {
  AgentScope,
  ResolvedRoute,
  RouteFieldProvenance,
  RoutingEntry,
  RoutingScope,
} from "../agents/types.js";
import type { KeyHint, RoutingKeyAction } from "./keys.js";
import { routingModelDisplayValue } from "./routing-editor.js";
import { boundNotice, fitLine, fitViewport } from "./text.js";

/** One row of the routing list: an agent plus its routing facts. */
export interface RoutingAgentRow {
  name: string;
  description: string;
  /** Scope the agent definition came from (not the mapping scope). */
  definitionScope: AgentScope;
  route: ResolvedRoute;
  /** Harness that would apply after removing the mapping for each scope. */
  inheritedHarness?: Partial<Record<RoutingScope, ResolvedRoute["harness"]>>;
  userEntry: RoutingEntry | undefined;
  projectEntry: RoutingEntry | undefined;
}

/** Per-scope invalid-file diagnostics (RoutingReadResult.invalidReason). */
export interface RoutingInvalidState {
  user?: string;
  project?: string;
}

export interface RoutingEditSession {
  agentName: string;
  scope: RoutingScope;
  /** Current mapping in that scope; empty object when none exists yet. */
  current: RoutingEntry;
  /** Resolved harness used when this mapping keeps harness inherited. */
  effectiveHarness?: ResolvedRoute["harness"];
}

export interface RoutingViewState {
  rows: readonly RoutingAgentRow[];
  selectedIndex: number;
  scope: RoutingScope;
  projectTrusted: boolean;
  invalid: RoutingInvalidState;
  /** Scope awaiting backup/reset confirmation, if any. */
  pendingReset: RoutingScope | undefined;
  /** Scope currently being backed up and reset. */
  resettingScope: RoutingScope | undefined;
  /** Open edit session; keyboard events are ignored while set. */
  editing: RoutingEditSession | undefined;
  notice: string | undefined;
  closed: boolean;
}

export type RoutingViewEvent =
  | { kind: "key"; action: RoutingKeyAction }
  | {
      kind: "rows-updated";
      rows: readonly RoutingAgentRow[];
      invalid?: RoutingInvalidState;
    }
  | { kind: "edit-committed"; entry: RoutingEntry }
  | { kind: "edit-cancelled" }
  | { kind: "reset-confirmed"; scope: RoutingScope; confirmed: boolean }
  | { kind: "reset-done"; scope: RoutingScope; backupPath: string }
  | { kind: "operation-failed"; message: string };

export type RoutingViewIntent =
  | { kind: "open-editor"; session: RoutingEditSession }
  | {
      kind: "save-mapping";
      scope: RoutingScope;
      agentName: string;
      entry: RoutingEntry;
    }
  | { kind: "delete-mapping"; scope: RoutingScope; agentName: string }
  | { kind: "confirm-reset"; scope: RoutingScope; reason: string }
  | { kind: "backup-and-reset"; scope: RoutingScope }
  | { kind: "request-refresh" }
  | { kind: "close" };

export interface RoutingViewStep {
  state: RoutingViewState;
  intents: RoutingViewIntent[];
}

export interface RoutingViewInit {
  rows?: readonly RoutingAgentRow[];
  projectTrusted: boolean;
  invalid?: RoutingInvalidState;
}

export function initialRoutingViewState(init: RoutingViewInit): RoutingViewState {
  return {
    rows: init.rows ?? [],
    selectedIndex: 0,
    scope: "user",
    projectTrusted: init.projectTrusted,
    invalid: init.invalid ?? {},
    pendingReset: undefined,
    resettingScope: undefined,
    editing: undefined,
    notice: undefined,
    closed: false,
  };
}

function step(
  state: RoutingViewState,
  intents: RoutingViewIntent[] = [],
): RoutingViewStep {
  return { state, intents };
}

function clampIndex(state: RoutingViewState, index: number): number {
  if (state.rows.length === 0) return 0;
  return Math.min(Math.max(0, index), state.rows.length - 1);
}

function selectedRow(state: RoutingViewState): RoutingAgentRow | undefined {
  return state.rows[state.selectedIndex];
}

function scopeEntry(
  row: RoutingAgentRow,
  scope: RoutingScope,
): RoutingEntry | undefined {
  return scope === "user" ? row.userEntry : row.projectEntry;
}

/** Normalize values returned by an adapter-owned field editor before saving. */
export function normalizeRoutingEntry(entry: RoutingEntry): RoutingEntry {
  const normalized: RoutingEntry = {};
  if (entry.harness === "pi" || entry.harness === "claude") {
    normalized.harness = entry.harness;
  }
  if (typeof entry.model === "string" && entry.model.trim().length > 0) {
    normalized.model = entry.model.trim();
  }
  if (
    entry.thinking === "off" ||
    entry.thinking === "minimal" ||
    entry.thinking === "low" ||
    entry.thinking === "medium" ||
    entry.thinking === "high" ||
    entry.thinking === "xhigh" ||
    entry.thinking === "max"
  ) {
    normalized.thinking = entry.thinking;
  }
  return normalized;
}

/** True when mutations are allowed in `scope` right now (trust gate only). */
export function isScopeEditable(state: RoutingViewState, scope: RoutingScope): boolean {
  return scope === "user" || state.projectTrusted;
}

export function reduceRoutingView(
  state: RoutingViewState,
  event: RoutingViewEvent,
): RoutingViewStep {
  if (state.closed) return step(state);
  switch (event.kind) {
    case "rows-updated":
      return step(applyRowsUpdate(state, event.rows, event.invalid));
    case "edit-committed": {
      if (!state.editing) return step(state);
      const { agentName, scope } = state.editing;
      if (!isScopeEditable(state, scope)) {
        return step({
          ...state,
          editing: undefined,
          notice: boundNotice("Project is untrusted; project routing is disabled."),
        });
      }
      const invalidReason = state.invalid[scope];
      if (invalidReason !== undefined) {
        return step(
          {
            ...state,
            editing: undefined,
            pendingReset: scope,
            notice: undefined,
          },
          [{ kind: "confirm-reset", scope, reason: boundNotice(invalidReason) }],
        );
      }
      return step({ ...state, editing: undefined, notice: undefined }, [
        {
          kind: "save-mapping",
          scope,
          agentName,
          entry: normalizeRoutingEntry(event.entry),
        },
      ]);
    }
    case "edit-cancelled":
      return step({ ...state, editing: undefined });
    case "reset-confirmed": {
      if (state.pendingReset !== event.scope) return step(state);
      const next = { ...state, pendingReset: undefined };
      if (!event.confirmed) return step(next);
      return step({ ...next, resettingScope: event.scope }, [
        { kind: "backup-and-reset", scope: event.scope },
      ]);
    }
    case "reset-done": {
      if (state.resettingScope !== event.scope) return step(state);
      const invalid = { ...state.invalid };
      delete invalid[event.scope];
      return step(
        {
          ...state,
          invalid,
          resettingScope: undefined,
          notice: boundNotice(
            `Invalid ${event.scope} routing file backed up to ${event.backupPath} and reset.`,
          ),
        },
        [{ kind: "request-refresh" }],
      );
    }
    case "operation-failed":
      return step({
        ...state,
        resettingScope: undefined,
        notice: boundNotice(event.message),
      });
    case "key":
      return reduceKey(state, event.action);
  }
}

function applyRowsUpdate(
  state: RoutingViewState,
  rows: readonly RoutingAgentRow[],
  invalid: RoutingInvalidState | undefined,
): RoutingViewState {
  const selectedName = selectedRow(state)?.name;
  const nextIndex =
    selectedName === undefined
      ? 0
      : rows.findIndex((row) => row.name === selectedName);
  const next: RoutingViewState = {
    ...state,
    rows,
    invalid: invalid ?? state.invalid,
    selectedIndex: nextIndex >= 0 ? nextIndex : 0,
  };
  next.selectedIndex = clampIndex(next, next.selectedIndex);
  return next;
}

/**
 * Gate a mutation on the active scope: returns an intercepting step when the
 * scope is invalid (backup/reset required first) or untrusted, undefined
 * when the mutation may proceed.
 */
function gateMutation(state: RoutingViewState): RoutingViewStep | undefined {
  if (!isScopeEditable(state, state.scope)) {
    return step({
      ...state,
      notice: boundNotice(
        "Project is untrusted; project routing is disabled.",
      ),
    });
  }
  const reason = state.invalid[state.scope];
  if (reason !== undefined) {
    return step(
      { ...state, pendingReset: state.scope, notice: undefined },
      [{ kind: "confirm-reset", scope: state.scope, reason: boundNotice(reason) }],
    );
  }
  return undefined;
}

function reduceKey(
  state: RoutingViewState,
  action: RoutingKeyAction,
): RoutingViewStep {
  // A nested editor/confirmation or in-flight reset owns mutation flow.
  if (state.editing || state.resettingScope !== undefined) return step(state);
  if (state.pendingReset !== undefined) {
    return action === "escape"
      ? step({ ...state, pendingReset: undefined })
      : step(state);
  }
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
    case "tab": {
      if (state.scope === "user" && !state.projectTrusted) {
        return step({
          ...state,
          notice: boundNotice(
            "Project is untrusted; project routing is disabled.",
          ),
        });
      }
      const scope: RoutingScope = state.scope === "user" ? "project" : "user";
      return step({ ...state, scope, notice: undefined });
    }
    case "enter": {
      const row = selectedRow(state);
      if (!row) return step(state);
      const gated = gateMutation(state);
      if (gated) return gated;
      const session: RoutingEditSession = {
        agentName: row.name,
        scope: state.scope,
        current: scopeEntry(row, state.scope) ?? {},
        effectiveHarness:
          row.inheritedHarness?.[state.scope] ?? row.route.harness,
      };
      return step({ ...state, editing: session, notice: undefined }, [
        { kind: "open-editor", session },
      ]);
    }
    case "delete-mapping": {
      const row = selectedRow(state);
      if (!row) return step(state);
      const gated = gateMutation(state);
      if (gated) return gated;
      if (scopeEntry(row, state.scope) === undefined) {
        return step({
          ...state,
          notice: boundNotice(`No ${state.scope} mapping for ${row.name}.`),
        });
      }
      return step({ ...state, notice: undefined }, [
        { kind: "delete-mapping", scope: state.scope, agentName: row.name },
      ]);
    }
    case "escape":
      return step({ ...state, closed: true }, [{ kind: "close" }]);
  }
}

// ---------------------------------------------------------------------------
// Line producers
// ---------------------------------------------------------------------------

export const ROUTING_KEY_HINTS: readonly KeyHint[] = [
  { key: "↑↓", description: "move" },
  { key: "tab", description: "scope" },
  { key: "enter", description: "edit" },
  { key: "d", description: "delete" },
  { key: "esc", description: "close" },
];

const PROVENANCE_LABEL: Record<RouteFieldProvenance, string> = {
  explicit: "arg",
  "saved-project": "proj",
  "saved-user": "user",
  "agent-default": "agent",
  parent: "parent",
};

export function formatRouteSummary(route: ResolvedRoute): string {
  const parts = [
    `${route.harness} (${PROVENANCE_LABEL[route.provenance.harness]})`,
    `${route.model ? routingModelDisplayValue(route.model) : "inherit"} (${PROVENANCE_LABEL[route.provenance.model]})`,
    `${route.thinking ?? "inherit"} (${PROVENANCE_LABEL[route.provenance.thinking]})`,
  ];
  return parts.join(" · ");
}

export function formatRoutingRow(
  row: RoutingAgentRow,
  scope: RoutingScope,
  selected: boolean,
  width: number,
): string {
  const marker = selected ? "›" : " ";
  const mapped = scopeEntry(row, scope) !== undefined ? "*" : " ";
  return fitLine(
    `${marker}${mapped}${row.name} [${row.definitionScope}] ${formatRouteSummary(row.route)}`,
    width,
  );
}

export function routingListLines(
  state: RoutingViewState,
  width: number,
  maxRows: number,
): string[] {
  if (width <= 0 || maxRows <= 0) return [];
  const trust =
    state.scope === "project" || state.projectTrusted
      ? ""
      : " (project untrusted)";
  const header = [fitLine(`scope: ${state.scope}${trust}`, width)];
  const invalidReason = state.invalid[state.scope];
  if (invalidReason !== undefined) {
    header.push(
      fitLine(`! invalid ${state.scope} routing file: ${invalidReason}`, width),
      fitLine("  press enter or d to back up and reset it", width),
    );
  }
  if (state.resettingScope !== undefined) {
    header.push(fitLine(`resetting ${state.resettingScope} routing…`, width));
  }

  const footer = state.notice
    ? [fitLine(`! ${state.notice}`, width)]
    : [];
  const available = Math.max(0, maxRows - header.length - footer.length);
  const rows =
    state.rows.length === 0
      ? [fitLine("No agents discovered.", width)].slice(0, available)
      : fitViewport(
          state.rows.map((row, index) =>
            formatRoutingRow(
              row,
              state.scope,
              index === state.selectedIndex,
              width,
            ),
          ),
          state.selectedIndex,
          width,
          available,
        );
  return [...header, ...rows, ...footer].slice(0, maxRows);
}
