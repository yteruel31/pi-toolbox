import { describe, expect, it } from "vitest";

import {
  createRoutingEditorState,
  reduceRoutingEditorInput,
  routingEntryFromEditor,
  routingModelChoices,
  selectedRoutingModelChoice,
  type RoutingModelCatalog,
} from "../src/tui/routing-editor.js";

const session = {
  agentName: "gig-security-reviewer",
  scope: "user" as const,
  current: {
    harness: "claude" as const,
    model: "fable",
    thinking: "high" as const,
  },
  effectiveHarness: "claude" as const,
};

const catalog: RoutingModelCatalog = {
  pi: [
    { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5" },
    {
      value: "openai/gpt-5.6",
      label: "GPT-5.6",
      thinking: "xhigh",
    },
  ],
  claude: [
    { value: "default", label: "Default" },
    {
      value: "claude-fable-5-1[1m]",
      label: "Fable",
      aliases: ["claude-fable-5-1"],
    },
    { value: "sonnet", label: "Sonnet" },
  ],
};

describe("in-panel routing editor", () => {
  it("starts from the mapping and keeps all fields in one editor state", () => {
    const state = createRoutingEditorState(session, catalog);
    expect(state).toMatchObject({
      selectedField: "harness",
      harness: "claude",
      effectiveHarness: "claude",
      model: "fable",
      thinking: "high",
    });
    expect(selectedRoutingModelChoice(state).label).toBe("fable (saved)");
  });

  it("navigates fields and selects a model without accepting typed identifiers", () => {
    let state = createRoutingEditorState(session, catalog);
    state = reduceRoutingEditorInput(state, "\x1b[B").state;
    expect(state.selectedField).toBe("model");

    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.model).toBe("default");
    state = reduceRoutingEditorInput(state, "manually-typed-model").state;
    expect(state.model).toBe("default");
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.model).toBe("claude-fable-5-1[1m]");
  });

  it("switches catalogues with the harness and clears incompatible model values", () => {
    let state = createRoutingEditorState(
      { ...session, effectiveHarness: "pi" },
      catalog,
    );
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.harness).toBe("inherit");
    expect(state.model).toBe("");

    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.harness).toBe("pi");
    expect(state.model).toBe("");
    expect(routingModelChoices(state).map((choice) => choice.value)).toEqual([
      "",
      "anthropic/claude-sonnet-5",
      "openai/gpt-5.6",
    ]);

    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state.harness).toBe("claude");
    expect(state.model).toBe("fable");
  });

  it("applies pinned thinking from a scoped Pi model until thinking is changed manually", () => {
    let state = createRoutingEditorState(
      { ...session, current: {}, effectiveHarness: "pi" },
      catalog,
    );
    state = reduceRoutingEditorInput(state, "\x1b[B").state;
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state).toMatchObject({
      model: "openai/gpt-5.6",
      thinking: "xhigh",
      thinkingFromModel: true,
    });

    state = reduceRoutingEditorInput(state, "\x1b[B").state;
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state).toMatchObject({ thinking: "high", thinkingFromModel: false });
    state = reduceRoutingEditorInput(state, "\x1b[A").state;
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state).toMatchObject({ model: "", thinking: "high" });
  });

  it("preserves manually selected thinking across harness round trips", () => {
    let state = createRoutingEditorState(
      { ...session, current: {}, effectiveHarness: "pi" },
      catalog,
    );
    state = {
      ...state,
      selectedField: "model",
    };
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.thinking).toBe("xhigh");
    state = {
      ...state,
      selectedField: "thinking",
    };
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state).toMatchObject({ thinking: "high", thinkingFromModel: false });

    state = { ...state, selectedField: "harness" };
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state).toMatchObject({
      harness: "pi",
      model: "openai/gpt-5.6",
      thinking: "high",
      thinkingFromModel: false,
    });
  });

  it("cycles inherited choice fields in both directions", () => {
    let state = createRoutingEditorState(
      { ...session, current: {}, effectiveHarness: "pi" },
      catalog,
    );
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.harness).toBe("pi");
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state.harness).toBe("inherit");

    state = reduceRoutingEditorInput(state, "\x1b[A").state;
    expect(state.selectedField).toBe("thinking");
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state.thinking).toBe("max");
  });

  it("preserves a saved model absent from the current catalogue as a legacy choice", () => {
    const state = createRoutingEditorState(
      { ...session, current: { harness: "claude", model: "retired-model" } },
      catalog,
    );
    const choices = routingModelChoices(state);
    expect(choices.map((choice) => choice.value)).toEqual([
      "",
      "retired-model",
      "default",
      "claude-fable-5-1[1m]",
      "sonnet",
    ]);
    expect(selectedRoutingModelChoice(state)).toMatchObject({
      value: "retired-model",
      legacy: true,
    });
  });

  it("does not confuse a saved model literally named inherit with the inherit option", () => {
    const state = createRoutingEditorState(
      { ...session, current: { harness: "claude", model: "inherit" } },
      catalog,
    );

    expect(selectedRoutingModelChoice(state)).toMatchObject({
      value: "inherit",
      legacy: true,
    });
    expect(routingEntryFromEditor(state).model).toBe("inherit");
  });

  it("sanitizes legacy model IDs for display without rewriting the saved value", () => {
    const unsafe = "legacy\u001b[31m\nmodel";
    const state = createRoutingEditorState(
      { ...session, current: { harness: "claude", model: unsafe } },
      catalog,
    );

    const selected = selectedRoutingModelChoice(state);
    expect(selected.label).toBe("legacy[31m model (saved)");
    expect(selected.label).not.toMatch(/[\u001b\n]/);
    expect(routingEntryFromEditor(state).model).toBe(unsafe);
  });

  it("recognizes an existing canonical model through a unique SDK alias", () => {
    const state = createRoutingEditorState(
      {
        ...session,
        current: { harness: "claude", model: "claude-fable-5-1" },
      },
      catalog,
    );

    const selected = selectedRoutingModelChoice(state);
    expect(selected).toMatchObject({
      value: "claude-fable-5-1",
      label: "Fable (saved)",
    });
    expect(selected.legacy).toBeUndefined();
    expect(routingEntryFromEditor(state).model).toBe("claude-fable-5-1");
  });

  it("returns the selected values in a save intent on enter", () => {
    const state = {
      ...createRoutingEditorState(session, catalog),
      harness: "inherit" as const,
      model: "fable",
      thinking: "max" as const,
    };
    const step = reduceRoutingEditorInput(state, "\r");

    expect(step.intent).toEqual({
      kind: "save",
      entry: { model: "fable", thinking: "max" },
    });
    expect(routingEntryFromEditor(state)).toEqual({ model: "fable", thinking: "max" });
  });

  it("returns to the mapping panel on escape without saving", () => {
    const state = createRoutingEditorState(session, catalog);
    expect(reduceRoutingEditorInput(state, "\x1b").intent).toEqual({ kind: "cancel" });
  });
});
