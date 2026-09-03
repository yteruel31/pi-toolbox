import { Key, matchesKey } from "@earendil-works/pi-tui";

import type { RoutingEntry } from "../agents/types.js";
import { sanitizeTerminalText } from "../shared/truncate.js";
import type { HarnessKind, ThinkingLevel } from "../shared/types.js";
import type { KeyHint } from "./keys.js";
import type { RoutingEditSession } from "./routing-view.js";

export const ROUTING_EDITOR_FIELDS = ["harness", "model", "thinking"] as const;
export type RoutingEditorField = (typeof ROUTING_EDITOR_FIELDS)[number];
export type HarnessChoice = "inherit" | HarnessKind;
export type ThinkingChoice =
  | "inherit"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface RoutingModelChoice {
  value: string;
  label: string;
  description?: string;
  /** Other accepted spellings, used only to recognize an existing saved value. */
  aliases?: readonly string[];
  /** Thinking level pinned by a Pi scoped-model entry. */
  thinking?: ThinkingLevel;
  /** A saved value absent from the currently available catalogue. */
  legacy?: boolean;
}

export interface RoutingModelCatalog {
  pi: readonly RoutingModelChoice[];
  claude: readonly RoutingModelChoice[];
}

const EMPTY_MODEL_CATALOG: RoutingModelCatalog = { pi: [], claude: [] };
const INHERIT_MODEL_CHOICE: RoutingModelChoice = {
  value: "",
  label: "inherit",
  description: "Use the model from the next matching route or agent default.",
};
const HARNESS_CHOICES: readonly HarnessChoice[] = ["inherit", "pi", "claude"];
export const ROUTING_EDITOR_KEY_HINTS: readonly KeyHint[] = [
  { key: "↑↓", description: "field" },
  { key: "←→", description: "change" },
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
  /** Harness whose catalogue applies while harness itself is inherited. */
  effectiveHarness: HarnessKind;
  model: string;
  modelByHarness: Record<HarnessKind, string>;
  modelCatalog: RoutingModelCatalog;
  thinking: ThinkingChoice;
  thinkingFromModel: boolean;
}

export type RoutingEditorIntent =
  | { kind: "save"; entry: RoutingEntry }
  | { kind: "cancel" };

export interface RoutingEditorStep {
  state: RoutingEditorState;
  intent?: RoutingEditorIntent;
}

export function createRoutingEditorState(
  session: RoutingEditSession,
  modelCatalog: RoutingModelCatalog = EMPTY_MODEL_CATALOG,
): RoutingEditorState {
  const effectiveHarness =
    session.effectiveHarness ?? session.current.harness ?? "pi";
  const activeHarness = session.current.harness ?? effectiveHarness;
  const model =
    typeof session.current.model === "string" && session.current.model.trim()
      ? session.current.model.trim()
      : "";
  return {
    session,
    selectedField: "harness",
    harness: session.current.harness ?? "inherit",
    effectiveHarness,
    model,
    modelByHarness: {
      pi: activeHarness === "pi" ? model : "",
      claude: activeHarness === "claude" ? model : "",
    },
    modelCatalog,
    thinking: session.current.thinking ?? "inherit",
    thinkingFromModel: false,
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
  if (state.selectedField === "model") {
    if (matchesKey(data, Key.left)) return { state: cycleModel(state, -1) };
    if (matchesKey(data, Key.right)) return { state: cycleModel(state, 1) };
    return { state };
  }
  if (matchesKey(data, Key.left)) return { state: cycleThinking(state, -1) };
  if (matchesKey(data, Key.right)) return { state: cycleThinking(state, 1) };
  return { state };
}

export function routingEntryFromEditor(state: RoutingEditorState): RoutingEntry {
  return {
    ...(state.harness === "pi" || state.harness === "claude"
      ? { harness: state.harness }
      : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.thinking !== "inherit" ? { thinking: state.thinking } : {}),
  };
}

/** Catalogue used by the current explicit harness, or the resolved harness. */
export function modelHarnessForEditor(state: RoutingEditorState): HarnessKind {
  return state.harness === "inherit" ? state.effectiveHarness : state.harness;
}

/** Available choices plus any no-longer-listed saved value. */
export function routingModelChoices(
  state: RoutingEditorState,
): readonly RoutingModelChoice[] {
  const available = state.modelCatalog[modelHarnessForEditor(state)];
  if (
    state.model === "" ||
    available.some((choice) => choice.value === state.model)
  ) {
    return [INHERIT_MODEL_CHOICE, ...available];
  }
  const aliasMatches = available.filter((choice) =>
    choice.aliases?.includes(state.model),
  );
  if (aliasMatches.length === 1) {
    const matched = aliasMatches[0]!;
    return [
      INHERIT_MODEL_CHOICE,
      {
        ...matched,
        value: state.model,
        label: `${matched.label} (saved)`,
        description: [
          `Saved as ${routingModelDisplayValue(state.model)}`,
          matched.description,
        ].filter(Boolean).join(" · "),
      },
      ...available,
    ];
  }
  return [
    INHERIT_MODEL_CHOICE,
    {
      value: state.model,
      label: `${routingModelDisplayValue(state.model)} (saved)`,
      description:
        "Saved model is not in the currently available catalogue; select another value to replace it.",
      legacy: true,
    },
    ...available,
  ];
}

export function routingModelDisplayValue(value: string): string {
  return (
    sanitizeTerminalText(value).replace(/\s+/g, " ").trim() ||
    "(invalid model id)"
  );
}

export function selectedRoutingModelChoice(
  state: RoutingEditorState,
): RoutingModelChoice {
  return (
    routingModelChoices(state).find((choice) => choice.value === state.model) ??
    INHERIT_MODEL_CHOICE
  );
}

function moveField(state: RoutingEditorState, delta: number): RoutingEditorState {
  const current = ROUTING_EDITOR_FIELDS.indexOf(state.selectedField);
  const next = modulo(current + delta, ROUTING_EDITOR_FIELDS.length);
  return { ...state, selectedField: ROUTING_EDITOR_FIELDS[next] ?? "harness" };
}

function cycleHarness(state: RoutingEditorState, delta: number): RoutingEditorState {
  const current = HARNESS_CHOICES.indexOf(state.harness);
  const harness =
    HARNESS_CHOICES[modulo(current + delta, HARNESS_CHOICES.length)] ?? "inherit";
  const previousModelHarness = modelHarnessForEditor(state);
  const nextModelHarness = harness === "inherit" ? state.effectiveHarness : harness;
  const modelByHarness = {
    ...state.modelByHarness,
    [previousModelHarness]: state.model,
  };
  let model = modelByHarness[nextModelHarness];
  if (
    !model &&
    state.model &&
    catalogueChoiceForValue(
      state.modelCatalog[nextModelHarness],
      state.model,
    )
  ) {
    model = state.model;
  }
  modelByHarness[nextModelHarness] = model;
  const choice = catalogueChoiceForValue(
    state.modelCatalog[nextModelHarness],
    model,
  );
  const autoThinking = state.thinkingFromModel
    ? thinkingAfterModelChoice(state, choice)
    : { thinking: state.thinking, thinkingFromModel: false };
  return {
    ...state,
    harness,
    model,
    modelByHarness,
    ...autoThinking,
  };
}

function cycleModel(state: RoutingEditorState, delta: number): RoutingEditorState {
  const choices = routingModelChoices(state);
  const current = Math.max(
    0,
    choices.findIndex((choice) => choice.value === state.model),
  );
  const choice = choices[modulo(current + delta, choices.length)] ??
    INHERIT_MODEL_CHOICE;
  const harness = modelHarnessForEditor(state);
  return {
    ...state,
    model: choice.value,
    modelByHarness: { ...state.modelByHarness, [harness]: choice.value },
    ...thinkingAfterModelChoice(state, choice),
  };
}

function catalogueChoiceForValue(
  choices: readonly RoutingModelChoice[],
  value: string,
): RoutingModelChoice | undefined {
  if (!value) return undefined;
  const exact = choices.find((choice) => choice.value === value);
  if (exact) return exact;
  const aliases = choices.filter((choice) => choice.aliases?.includes(value));
  return aliases.length === 1 ? aliases[0] : undefined;
}

function thinkingAfterModelChoice(
  state: RoutingEditorState,
  choice: RoutingModelChoice | undefined,
): Pick<RoutingEditorState, "thinking" | "thinkingFromModel"> {
  if (choice?.thinking) {
    return { thinking: choice.thinking, thinkingFromModel: true };
  }
  if (state.thinkingFromModel) {
    return { thinking: "inherit", thinkingFromModel: false };
  }
  return {
    thinking: state.thinking,
    thinkingFromModel: false,
  };
}

function cycleThinking(state: RoutingEditorState, delta: number): RoutingEditorState {
  const current = THINKING_CHOICES.indexOf(state.thinking);
  return {
    ...state,
    thinking: THINKING_CHOICES[modulo(current + delta, THINKING_CHOICES.length)] ?? "inherit",
    thinkingFromModel: false,
  };
}

function modulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
