/**
 * /subagents command-mode selection plus the chooser reducer.
 *
 * `/subagents`        → chooser between run inspection and agent routing
 * `/subagents runs`   → runs view directly
 * `/subagents agents` → routing view directly
 *
 * Pure: no UI calls, no Pi APIs. The concrete command handler parses args
 * with `parseSubagentsCommand`, then either drives the chooser reducer
 * inside a ctx.ui.custom() component or falls back to text summaries when
 * there is no UI.
 */

import type { ChooserKeyAction, KeyHint } from "./keys.js";
import { boundNotice, fitLine, fitViewport } from "./text.js";

export type SubagentsView = "runs" | "agents";
export type SubagentsMode = SubagentsView | "chooser";

export interface ParsedSubagentsCommand {
  mode: SubagentsMode;
  /** Bounded warning when the argument was not recognized. */
  warning?: string;
}

export type PiCommandMode = "tui" | "rpc" | "json" | "print";

/** Custom components and overlays are valid only in real TUI mode. */
export function commandPresentation(
  mode: PiCommandMode,
  hasUI: boolean,
): "interactive" | "text" {
  return mode === "tui" && hasUI ? "interactive" : "text";
}

/** Parse the raw argument string of /subagents into a target mode. */
export function parseSubagentsCommand(
  args: string | undefined,
): ParsedSubagentsCommand {
  const trimmed = (args ?? "").trim().toLowerCase();
  if (trimmed === "") return { mode: "chooser" };
  if (trimmed === "runs") return { mode: "runs" };
  if (trimmed === "agents") return { mode: "agents" };
  return {
    mode: "chooser",
    warning: boundNotice(
      `Unknown /subagents argument "${trimmed}"; expected "runs" or "agents".`,
    ),
  };
}

export interface ChooserItem {
  view: SubagentsView;
  label: string;
  description: string;
}

export const CHOOSER_ITEMS: readonly ChooserItem[] = [
  {
    view: "runs",
    label: "Runs",
    description: "Inspect, refresh, and cancel subagent runs",
  },
  {
    view: "agents",
    label: "Agents",
    description: "Edit harness/model/thinking routing per agent",
  },
];

export interface ChooserState {
  selectedIndex: number;
  closed: boolean;
}

export type ChooserIntent =
  | { kind: "open-view"; view: SubagentsView }
  | { kind: "close" };

export interface ChooserStep {
  state: ChooserState;
  intents: ChooserIntent[];
}

export function initialChooserState(): ChooserState {
  return { selectedIndex: 0, closed: false };
}

export function reduceChooser(
  state: ChooserState,
  action: ChooserKeyAction,
): ChooserStep {
  if (state.closed) return { state, intents: [] };
  switch (action) {
    case "up": {
      const selectedIndex = Math.max(0, state.selectedIndex - 1);
      return { state: { ...state, selectedIndex }, intents: [] };
    }
    case "down": {
      const selectedIndex = Math.min(
        CHOOSER_ITEMS.length - 1,
        state.selectedIndex + 1,
      );
      return { state: { ...state, selectedIndex }, intents: [] };
    }
    case "enter": {
      const item = CHOOSER_ITEMS[state.selectedIndex];
      if (!item) return { state, intents: [] };
      return {
        state: { ...state, closed: true },
        intents: [{ kind: "open-view", view: item.view }],
      };
    }
    case "escape":
      return { state: { ...state, closed: true }, intents: [{ kind: "close" }] };
  }
}

export const CHOOSER_KEY_HINTS: readonly KeyHint[] = [
  { key: "↑↓", description: "move" },
  { key: "enter", description: "open" },
  { key: "esc", description: "close" },
];

export function chooserLines(
  state: ChooserState,
  width: number,
  maxRows: number,
  warning?: string,
): string[] {
  if (width <= 0 || maxRows <= 0) return [];
  const suffix = warning ? [fitLine(`! ${boundNotice(warning)}`, width)] : [];
  const available = Math.max(0, maxRows - suffix.length);
  const rows = CHOOSER_ITEMS.map((item, index) =>
    fitLine(
      `${index === state.selectedIndex ? "›" : " "} ${item.label} · ${item.description}`,
      width,
    ),
  );
  return [
    ...fitViewport(rows, state.selectedIndex, width, available),
    ...suffix,
  ].slice(0, maxRows);
}
