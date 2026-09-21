import { describe, expect, it, vi } from "vitest";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { JevSetupSnapshot } from "../src/agents/jev-config.js";
import { JevSetupPanel, jevSetupRows } from "../src/tui/jev-setup.js";

const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as never;
const kb = { matches: (data: string, id: string) => matchesKey(data, ({ "tui.select.cancel": "escape" } as Record<string, string>)[id] as never) } as never;
const enter = "\r", down = "\x1b[B", right = "\x1b[C", escape = "\x1b";
function harness(snapshot: JevSetupSnapshot = {}, overrides: { save?: (...args: any[]) => Promise<void>; test?: (...args: any[]) => Promise<void> } = {}) {
  const saves: unknown[] = [], tests: unknown[] = [], done: boolean[] = [];
  let rows = 22;
  const panel = new JevSetupPanel({ theme, keybindings: kb, snapshot, defaultFile: "/tmp/agent/jev-key.json", maxRows: () => rows, onRender: () => {}, onDone: (value) => done.push(value),
    onSave: async (draft) => { saves.push(structuredClone(draft)); await overrides.save?.(draft); },
    onTest: async (draft, signal) => { tests.push({ draft: structuredClone(draft), signal }); await overrides.test?.(draft, signal); } });
  panel.focused = true;
  return { panel, saves, tests, done, input: (...keys: string[]) => keys.forEach((key) => panel.handleInput(key)), rows: (value: number) => { rows = value; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("Jev Setup panel", () => {
  it("cancels a new draft without saving", () => { const h = harness(); h.input(right, down, right, escape); expect(h.saves).toEqual([]); expect(h.done).toEqual([false]); });

  it("saves the exact staged draft while retaining a reopened file credential", async () => {
    const snapshot: JevSetupSnapshot = { config: { version: 1, enabled: true, credential: { source: "file", value: "/tmp/saved-key.json" } } };
    const h = harness(snapshot); h.input(down, down, down, down, enter); await tick();
    expect(h.saves).toEqual([{ enabled: true, source: "file", reference: "/tmp/saved-key.json", key: undefined }]); expect(h.panel.render(72).join("\n")).not.toContain("secret-value");
  });

  it("uses source-specific defaults and requires a key for newly selected storage", async () => {
    const h = harness(); h.input(down, right, right); // source environment -> keyring -> file
    h.input("\x13"); await tick(); expect(h.saves).toEqual([]);
    expect(h.panel.render(72).join("\n")).toContain("newly selected private file");
    expect(h.panel.render(72).join("\n").replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|_pi:c\x07)/g, "")).toContain("/tmp/agent/jev-key.json");
  });

  it("aborts explicit tests on cancel/dispose and ignores late completion", async () => {
    let resolve!: () => void; const test = vi.fn((_draft, _signal) => new Promise<void>((done) => { resolve = done; }));
    const h = harness({}, { test }); h.input("t"); await tick(); const signal = (h.tests[0] as any).signal as AbortSignal;
    h.input(escape); expect(signal.aborted).toBe(true); resolve(); await tick(); expect(h.done).toEqual([]); expect(h.panel.render(72).join("\n")).not.toContain("succeeded");
    h.input("t"); await tick(); const second = (h.tests[1] as any).signal as AbortSignal; h.panel.dispose(); expect(second.aborted).toBe(true);
  });

  it("blocks rejected paste from test and save and keeps it masked", async () => {
    const h = harness(); h.input(down, right, right, down, down, enter, "\x1b[200~bad key\x1b[201~", enter, "t", "\x13"); await tick();
    expect(h.tests).toEqual([]); expect(h.saves).toEqual([]); const output = h.panel.render(72).join("\n"); expect(output).not.toContain("bad key"); expect(output).toContain("Key not accepted");
  });

  it("renders bounded panels and sanitized storage guidance", async () => {
    const h = harness({}, { test: async () => { throw new Error("raw-private-sentinel"); } }); h.input("t"); await tick();
    const text = h.panel.render(72).join("\n"); expect(text).not.toContain("raw-private-sentinel"); expect(text).toContain("Could not save Jev settings");
    for (const rows of [10, 12, 22]) for (const width of [32, 40, 72]) { h.rows(rows); const lines = h.panel.render(width); expect(lines.length).toBeLessThanOrEqual(rows); expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true); expect(lines.at(-1)).toMatch(/╯$/); }
    expect(jevSetupRows(60)).toBe(22);
  });
});
