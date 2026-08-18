/**
 * Keyboard vocabulary for the /subagents TUI, kept free of any terminal
 * dependency. Raw input decoding (escape sequences, `matchesKey`, user
 * remaps) happens in the concrete binding layer; the reducers in this
 * package only ever see these normalized actions.
 */

/** Actions understood by the chooser (runs vs agents). */
export type ChooserKeyAction = "up" | "down" | "enter" | "escape";

/**
 * Actions understood by the runs view. "cancel-run" is the cancellation
 * intent key (`c`), "refresh" re-polls run data (`r`), "takeover" toggles
 * keyboard capture of the detail panel (`t`).
 */
export type RunsKeyAction =
  | "up"
  | "down"
  | "enter"
  | "escape"
  | "refresh"
  | "cancel-run"
  | "takeover";

/**
 * Actions understood by the routing editor, straight from SPEC.md:
 * arrows navigate, Tab toggles user/project scope, Enter edits,
 * `d` deletes the selected mapping, Esc closes.
 */
export type RoutingKeyAction =
  | "up"
  | "down"
  | "tab"
  | "enter"
  | "delete-mapping"
  | "escape";

/**
 * Binding-time translator from raw terminal input to a normalized action.
 * The concrete adapter uses `matchesKey`/`Key` from @earendil-works/pi-tui;
 * tests may implement it with a simple map.
 * Return undefined for input the view does not handle.
 */
export type KeyTranslator<A extends string> = (data: string) => A | undefined;

/** One help-line entry: a key label plus what it does. */
export interface KeyHint {
  key: string;
  description: string;
}

/** Render key hints as a single bounded help line ("↑↓ move · enter open"). */
export function formatKeyHints(hints: readonly KeyHint[]): string {
  return hints.map((h) => `${h.key} ${h.description}`).join(" · ");
}
