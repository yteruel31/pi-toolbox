import { describe, expect, it } from "vitest";

import {
  createRoutingEditorState,
  reduceRoutingEditorInput,
  routingEntryFromEditor,
} from "../src/tui/routing-editor.js";

const session = {
  agentName: "gig-security-reviewer",
  scope: "user" as const,
  current: {
    harness: "claude" as const,
    model: "fable",
    thinking: "high" as const,
  },
};

describe("in-panel routing editor", () => {
  it("starts from the mapping and keeps all fields in one editor state", () => {
    const state = createRoutingEditorState(session);
    expect(state).toMatchObject({
      selectedField: "harness",
      harness: "claude",
      model: "fable",
      modelCursor: 5,
      thinking: "high",
    });
  });

  it("navigates fields and edits the model without opening another UI", () => {
    let state = createRoutingEditorState(session);
    state = reduceRoutingEditorInput(state, "\x1b[B").state;
    expect(state.selectedField).toBe("model");

    state = reduceRoutingEditorInput(state, "\x15").state;
    state = reduceRoutingEditorInput(state, "openai/gpt-5").state;
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    state = reduceRoutingEditorInput(state, "X").state;

    expect(state.model).toBe("openai/gpt-X5");
    expect(state.modelCursor).toBe(12);
  });

  it("cycles inherited choice fields in both directions", () => {
    let state = createRoutingEditorState({
      ...session,
      current: {},
    });
    state = reduceRoutingEditorInput(state, "\x1b[C").state;
    expect(state.harness).toBe("pi");
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state.harness).toBe("inherit");

    state = reduceRoutingEditorInput(state, "\x1b[A").state;
    expect(state.selectedField).toBe("thinking");
    state = reduceRoutingEditorInput(state, "\x1b[D").state;
    expect(state.thinking).toBe("max");
  });

  it("returns a normalized save intent on enter", () => {
    let state = createRoutingEditorState(session);
    state = { ...state, harness: "inherit", model: "  fable  ", thinking: "max" };
    const step = reduceRoutingEditorInput(state, "\r");

    expect(step.intent).toEqual({
      kind: "save",
      entry: { model: "fable", thinking: "max" },
    });
    expect(routingEntryFromEditor(state)).toEqual({ model: "fable", thinking: "max" });
  });

  it("returns to the mapping panel on escape without saving", () => {
    const state = createRoutingEditorState(session);
    expect(reduceRoutingEditorInput(state, "\x1b").intent).toEqual({ kind: "cancel" });
  });
});
