import { decodeKittyPrintable, Key, matchesKey } from "@earendil-works/pi-tui";

import type { RoutingEntry } from "../agents/types.js";
import type { KeyHint } from "./keys.js";
import type { RoutingEditSession } from "./routing-view.js";

export const ROUTING_EDITOR_FIELDS = ["harness", "model", "thinking"] as const;
export type RoutingEditorField = (typeof ROUTING_EDITOR_FIELDS)[number];
export type HarnessChoice = "inherit" | "pi" | "claude";
export type ThinkingChoice =
  | "inherit"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

const HARNESS_CHOICES: readonly HarnessChoice[] = ["inherit", "pi", "claude"];
export const ROUTING_EDITOR_KEY_HINTS: readonly KeyHint[] = [
  { key: "↑↓", description: "field" },
  { key: "←→", description: "change" },
  { key: "type", description: "model" },
  { key: "enter", description: "save" },
  { key: "esc", description: "back" },
];

const THINKING_CHOICES: readonly ThinkingChoice[] = [
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export interface RoutingEditorState {
  session: RoutingEditSession;
  selectedField: RoutingEditorField;
  harness: HarnessChoice;
  model: string;
  /** Unicode code-point offset used by the in-panel model editor. */
  modelCursor: number;
  thinking: ThinkingChoice;
}

export type RoutingEditorIntent =
  | { kind: "save"; entry: RoutingEntry }
  | { kind: "cancel" };

export interface RoutingEditorStep {
  state: RoutingEditorState;
  intent?: RoutingEditorIntent;
}

export function createRoutingEditorState(session: RoutingEditSession): RoutingEditorState {
  const model = typeof session.current.model === "string" ? session.current.model : "";
  return {
    session,
    selectedField: "harness",
    harness: session.current.harness ?? "inherit",
    model,
    modelCursor: Array.from(model).length,
    thinking: session.current.thinking ?? "inherit",
  };
}

export function reduceRoutingEditorInput(
  state: RoutingEditorState,
  data: string,
): RoutingEditorStep {
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
    return { state, intent: { kind: "cancel" } };
  }
  if (matchesKey(data, Key.enter)) {
    return { state, intent: { kind: "save", entry: routingEntryFromEditor(state) } };
  }
  if (matchesKey(data, Key.up) || matchesKey(data, Key.shift("tab"))) {
    return { state: moveField(state, -1) };
  }
  if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
    return { state: moveField(state, 1) };
  }

  if (state.selectedField === "harness") {
    if (matchesKey(data, Key.left)) return { state: cycleHarness(state, -1) };
    if (matchesKey(data, Key.right)) return { state: cycleHarness(state, 1) };
    return { state };
  }
  if (state.selectedField === "thinking") {
    if (matchesKey(data, Key.left)) return { state: cycleThinking(state, -1) };
    if (matchesKey(data, Key.right)) return { state: cycleThinking(state, 1) };
    return { state };
  }
  return { state: editModel(state, data) };
}

export function routingEntryFromEditor(state: RoutingEditorState): RoutingEntry {
  return {
    ...(state.harness === "pi" || state.harness === "claude"
      ? { harness: state.harness }
      : {}),
    ...(state.model.trim() ? { model: state.model.trim() } : {}),
    ...(state.thinking !== "inherit" ? { thinking: state.thinking } : {}),
  };
}

function moveField(state: RoutingEditorState, delta: number): RoutingEditorState {
  const current = ROUTING_EDITOR_FIELDS.indexOf(state.selectedField);
  const next = modulo(current + delta, ROUTING_EDITOR_FIELDS.length);
  return { ...state, selectedField: ROUTING_EDITOR_FIELDS[next] ?? "harness" };
}

function cycleHarness(state: RoutingEditorState, delta: number): RoutingEditorState {
  const current = HARNESS_CHOICES.indexOf(state.harness);
  return {
    ...state,
    harness: HARNESS_CHOICES[modulo(current + delta, HARNESS_CHOICES.length)] ?? "inherit",
  };
}

function cycleThinking(state: RoutingEditorState, delta: number): RoutingEditorState {
  const current = THINKING_CHOICES.indexOf(state.thinking);
  return {
    ...state,
    thinking: THINKING_CHOICES[modulo(current + delta, THINKING_CHOICES.length)] ?? "inherit",
  };
}

function editModel(state: RoutingEditorState, data: string): RoutingEditorState {
  const characters = Array.from(state.model);
  const cursor = Math.min(Math.max(0, state.modelCursor), characters.length);
  if (matchesKey(data, Key.left)) {
    return { ...state, modelCursor: Math.max(0, cursor - 1) };
  }
  if (matchesKey(data, Key.right)) {
    return { ...state, modelCursor: Math.min(characters.length, cursor + 1) };
  }
  if (matchesKey(data, Key.home)) return { ...state, modelCursor: 0 };
  if (matchesKey(data, Key.end)) return { ...state, modelCursor: characters.length };
  if (matchesKey(data, Key.ctrl("u"))) {
    return { ...state, model: "", modelCursor: 0 };
  }
  if (matchesKey(data, Key.backspace)) {
    if (cursor === 0) return state;
    characters.splice(cursor - 1, 1);
    return { ...state, model: characters.join(""), modelCursor: cursor - 1 };
  }
  if (matchesKey(data, Key.delete)) {
    if (cursor >= characters.length) return state;
    characters.splice(cursor, 1);
    return { ...state, model: characters.join("") };
  }
  const printable = printableInput(data);
  if (!printable) return state;
  const inserted = Array.from(printable);
  characters.splice(cursor, 0, ...inserted);
  return {
    ...state,
    model: characters.join(""),
    modelCursor: cursor + inserted.length,
  };
}

function printableInput(data: string): string | undefined {
  const kitty = decodeKittyPrintable(data);
  if (kitty !== undefined) return kitty;
  if (data.length === 0 || data.includes("\u001b") || data.includes("\u0000")) return undefined;
  for (const character of data) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || codePoint === 0x7f) return undefined;
  }
  return data;
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
