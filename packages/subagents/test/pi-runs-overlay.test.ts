import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  isFocusable,
  type Component,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { RunInspection, RunListEntry } from "../src/shared/types.js";
import type { RunsDataPort } from "../src/tui/binding.js";
import { openPiRunsOverlay } from "../src/tui/pi-views.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  inverse: (text: string) => text,
} as unknown as Theme;

function activeInspection(transcriptSize = 20): RunInspection {
  return {
    id: "run-1",
    title: "Interactive run",
    harness: "pi",
    status: "running",
    createdAt: 0,
    settledAt: undefined,
    elapsedMs: 1_000,
    cancelRequested: false,
    model: "anthropic/test",
    usage: undefined,
    activity: [],
    activityDropped: 0,
    transcript: Array.from({ length: transcriptSize }, (_, index) => ({
      kind: "assistant" as const,
      at: index,
      text: `assistant event ${index}`,
    })),
    transcriptDropped: 2,
    messaging: { supported: true, editable: true },
    resultPreview: undefined,
    consumption: "none",
  };
}

function run(status: RunListEntry["status"] = "running"): RunListEntry {
  return {
    id: "run-1",
    title: "Interactive run",
    harness: "pi",
    status,
    elapsedMs: 1_000,
    model: "anthropic/test",
  };
}

describe("concrete interactive runs overlay", () => {
  it("focuses the Pi Editor, handles plain run shortcuts, submits, scrolls, and becomes read-only", async () => {
    let inspection = activeInspection();
    let listener: (() => void) | undefined;
    let inspectCount = 0;
    const sent: string[] = [];
    const cancelled: string[] = [];
    let component!: Component & { focused: boolean };
    let doneCalls = 0;
    const tui = {
      terminal: { rows: 28, columns: 100 },
      requestRender: vi.fn(),
    } as unknown as TUI;
    const handle = {
      focus() { component.focused = true; },
      unfocus() { component.focused = false; },
      hide() {},
      setHidden() {},
      isHidden: () => false,
      isFocused: () => component.focused,
    } as unknown as OverlayHandle;
    const ctx = {
      mode: "tui",
      ui: {
        confirm: async () => true,
        custom: async (
          factory: (tui: TUI, theme: Theme, keybindings: unknown, done: () => void) => Component,
          options: { onHandle?: (handle: OverlayHandle) => void },
        ) => {
          component = factory(tui, theme, {}, () => { doneCalls += 1; }) as Component & { focused: boolean };
          options.onHandle?.(handle);
          return undefined;
        },
      },
    } as unknown as ExtensionContext;
    const port: RunsDataPort = {
      list: () => [run(inspection.status)],
      inspect: () => {
        inspectCount += 1;
        return inspection;
      },
      sendMessage: async (_id, text) => { sent.push(text); },
      cancel: (id) => { cancelled.push(id); },
      subscribe(next) {
        listener = next;
        return () => { listener = undefined; };
      },
    };

    await openPiRunsOverlay(ctx, port);
    expect(isFocusable(component)).toBe(true);
    component.handleInput?.("\r"); // list Enter opens detail immediately
    let rendered = component.render(100).join("\n");
    expect(rendered).toContain(CURSOR_MARKER);

    const inspectCountBeforeRefresh = inspectCount;
    component.handleInput?.("r");
    await vi.waitFor(() => expect(inspectCount).toBeGreaterThan(inspectCountBeforeRefresh));
    component.handleInput?.("c");
    component.handleInput?.("t");
    rendered = component.render(100).join("\n");
    expect(rendered).toContain("ct");

    // Shift+Enter inserts a newline; it must not submit.
    component.handleInput?.("\x1b[13;2u");
    expect(sent).toEqual([]);
    component.handleInput?.("more");
    component.handleInput?.("\r");
    await vi.waitFor(() => expect(sent).toEqual(["ct\nmore"]));

    component.handleInput?.("x");
    await vi.waitFor(() => expect(cancelled).toEqual(["run-1"]));

    component.handleInput?.("\x1b[5~");
    expect(component.render(100).join("\n")).toContain("newer event");
    component.handleInput?.("\x1b[6~");

    // Ctrl+C belongs to the editor and must not close the detail panel.
    component.handleInput?.("\x03");
    expect(doneCalls).toBe(0);
    expect(component.render(100).join("\n")).toContain("run-1");

    inspection = {
      ...inspection,
      status: "completed",
      settledAt: 2_000,
      messaging: { supported: true, editable: false, reason: "Run completed; transcript is read-only." },
    };
    listener?.();
    rendered = component.render(100).join("\n");
    expect(rendered).toContain("READ ONLY");
    expect(rendered).not.toContain(CURSOR_MARKER);

    component.handleInput?.("\x1b");
    expect(component.render(100).join("\n")).toContain("SUBAGENT RUNS");
    component.handleInput?.("\x1b");
    expect(doneCalls).toBe(1);
  });
});
