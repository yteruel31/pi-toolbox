import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { parseConfig } from "../src/config.js";
import { SetupError, type SetupDraft, type SetupSnapshot } from "../src/setup-store.js";
import { SecretInput } from "../src/tui/secret-input.js";
import { SETUP_OVERLAY, SetupPanel, setupRows } from "../src/tui/setup-panel.js";
import type { DiagnosticReport, RenderProbeResult } from "../src/diagnostics.js";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const kb = { matches: (data: string, id: string) => matchesKey(data, ({ "tui.select.confirm": "enter", "tui.select.cancel": "escape", "tui.select.up": "up", "tui.select.down": "down" } as Record<string, string>)[id] as never) } as never;
const enter = "\r", down = "\x1b[B", up = "\x1b[A", back = "\x1b[1;3D", escape = "\x1b";
function harness(root: Record<string, unknown> = {}, save?: (draft: SetupDraft, key?: string) => Promise<void>, diagnostics: { inspect?: () => Promise<DiagnosticReport>; testRender?: (signal: AbortSignal) => Promise<RenderProbeResult> } = {}) {
  const snapshot: SetupSnapshot = { agentDir: "/tmp/not-used", root, config: parseConfig(root, "/tmp/not-used") };
  const saves: Array<{ draft: SetupDraft; key?: string }> = [];
  const done: boolean[] = [];
  let rows = 22;
  const panel = new SetupPanel({ inspect: async () => ({ checks: [], remedies: [] }), ...diagnostics, theme, keybindings: kb, snapshot, maxRows: () => rows, onRender: () => {}, onDone: (saved) => done.push(saved), onSave: async (draft, key) => { saves.push({ draft, key }); await save?.(draft, key); } });
  panel.focused = true;
  const input = (...keys: string[]) => { for (const key of keys) { panel.render(72); panel.handleInput(key); } };
  const text = (width = 72) => stripVTControlCharacters(panel.render(width).join("\n")).replaceAll("\x1b_pi:c\x07", "");
  return { panel, saves, done, input, text, rows: (value: number) => { rows = value; } };
}
function toStorage(h: ReturnType<typeof harness>) { h.input(enter, enter, enter, enter, enter); assert.match(h.text(), /Credential storage/); }
function toKey(h: ReturnType<typeof harness>, keyring = false) { toStorage(h); h.input(down, ...(keyring ? [down] : []), enter); assert.match(h.text(), /API key/); }
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("secret entry masks every render, supports editing and never serializes its value", () => {
  const input = new SecretInput(); input.focused = true;
  input.handleInput("fixture-abc");
  assert.equal(input.getValue(), "fixture-abc");
  for (const width of [1, 2, 8, 32, 80]) {
    const lines = input.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.doesNotMatch(lines.join(""), /fixture|abc/);
  }
  assert.doesNotMatch(JSON.stringify(input), /fixture/);
  input.handleInput("\x1b[D"); input.handleInput("\x7f");
  assert.equal(input.getValue(), "fixture-ac");
  input.handleInput("\x1b[3~"); assert.equal(input.getValue(), "fixture-a");
  input.handleInput("\x15"); assert.equal(input.getValue(), "");
  input.handleInput("\x19"); assert.equal(input.getValue(), ""); // No yank/kill ring.
  input.handleInput("fixture"); input.dispose(); assert.equal(input.getValue(), "");
});

test("secret paste handles chunking, shell metacharacters and Kitty printable input without interpreting shortcuts", () => {
  const input = new SecretInput();
  input.handleInput("\x1b[200~fixture-$;`");
  input.handleInput("abc\x1b[20"); input.handleInput("1~\r");
  assert.equal(input.getValue(), "fixture-$;`abc");
  input.handleInput("\x1b[120u"); assert.equal(input.getValue(), "fixture-$;`abcx");
  input.handleInput("\x1b[200~bad\r\nkey\x1b[201~");
  assert.equal(input.invalid, true); assert.equal(input.getValue(), "fixture-$;`abcx");
  input.clear(); input.handleInput("\x1b[200~" + "x".repeat(17000));
  input.handleInput("\x1b[201~"); assert.equal(input.invalid, true); assert.equal(input.getValue(), "");
});

test("modifyOtherKeys printable input is preserved, but modifier shortcuts are not inserted", () => {
  const input = new SecretInput();
  input.handleInput("fixture-");
  input.handleInput("\x1b[27;2;65~"); // Shift+A
  input.handleInput("\x1b[27;1;98~"); // Plain b
  input.handleInput("\x1b[27;66;67~"); // Shift+Caps Lock+C
  assert.equal(input.getValue(), "fixture-AbC");
  for (const modifier of [3, 4, 5, 6, 9, 17]) input.handleInput(`\x1b[27;${modifier};120~`);
  assert.equal(input.getValue(), "fixture-AbC");
  input.handleInput(" "); assert.equal(input.invalid, true);
  assert.doesNotMatch(input.render(80).join(""), /fixture-AbC/);
});

test("cancel is side-effect free at every wizard stage and closes once", () => {
  for (let step = 0; step < 8; step++) {
    const h = harness();
    for (let i = 0; i < step; i++) {
      if (h.text().includes("Credential storage")) h.input(down);
      if (h.text().includes("Enter the gemini API key")) h.input("fixture");
      h.input(enter);
    }
    h.input(escape, enter, "\x13");
    assert.deepEqual(h.done, [false]); assert.equal(h.saves.length, 0);
    assert.doesNotMatch(h.text(), /fixture/);
  }
});

test("back navigation retains confirmed choices and never saves early", () => {
  const h = harness();
  h.input(down, enter, enter); // OpenAI, enabled -> search
  assert.match(h.text(), /gpt-5-mini/);
  h.input("\x15", "search-custom", enter, back);
  assert.match(h.text(), /search-custom/);
  h.input(back, back); assert.match(h.text(), /Search provider/);
  assert.equal(h.saves.length, 0);
  h.input(escape);
});

test("file selection and masked key require a separate final confirmation", async () => {
  const h = harness({ credentials: { gemini: "do-not-display-literal", brave: "$BRAVE_API_KEY" } });
  toKey(h);
  h.input("\x1b[200~fixture-key\x1b[201~");
  assert.doesNotMatch(h.text(), /fixture-key|do-not-display-literal/);
  assert.doesNotMatch(JSON.stringify(h.panel), /fixture-key|do-not-display-literal/);
  h.input(enter);
  assert.match(h.text(), /Review changes/);
  assert.match(h.text(), /API key: entered \(hidden\)/);
  assert.equal(h.saves.length, 0);
  h.input(enter, enter); // Busy guard prevents a second save.
  await tick();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0]!.key, "fixture-key");
  assert.equal(h.saves[0]!.draft.storage, "file"); assert.deepEqual(h.done, [true]);
  assert.doesNotMatch(h.text(), /fixture-key/);
});

test("chunked key and model pastes cannot advance or confirm the wizard", () => {
  const h = harness(); toKey(h);
  h.input("\x1b[200~", "\r", "\x1b[201~");
  assert.match(h.text(), /API key/); assert.equal(h.saves.length, 0);
  h.input(enter); assert.match(h.text(), /API key/);
  const m = harness(); m.input(enter, enter);
  m.input("\x1b[200~", "\r", "\x1b[201~");
  assert.match(m.text(), /Native search model/); assert.match(m.text(), /Paste rejected/);
});

test("Brave skips native models but keeps Pi synthesis separate", async () => {
  const h = harness({ search: { provider: "brave" }, synthesisModel: "anthropic/fixture-model" });
  h.input(enter, enter);
  assert.match(h.text(), /Pi synthesis model/); assert.match(h.text(), /Brave has no native/);
  h.input(enter, enter); assert.match(h.text(), /Review changes/);
  assert.doesNotMatch(h.text(), /Search model:|Research model:/);
  h.input(enter); await tick();
  assert.equal(h.saves[0]!.draft.provider, "brave");
  assert.equal(h.saves[0]!.draft.storage, "keep"); assert.equal(h.saves[0]!.key, undefined);
});

test("switching provider clears an entered key and resets its native defaults", () => {
  const h = harness(); toKey(h); h.input("fixture-key");
  h.input(back, back, back, back, back, back); assert.match(h.text(), /Search provider/);
  h.input(down, enter, enter); assert.match(h.text(), /gpt-5-mini/);
  h.input(enter, enter, enter, enter); assert.match(h.text(), /API key/);
  h.input(enter); assert.match(h.text(), /Enter a non-empty API key/);
});

test("keyring failure is actionable and returning to file storage is intentional", async () => {
  const h = harness({}, async (draft) => { if (draft.storage === "keyring") throw new SetupError("keyring"); });
  toKey(h, true); h.input("fixture", enter, enter); await tick();
  assert.match(h.text(), /libsecret-tools/); assert.equal(h.saves.length, 1);
  h.input(enter); assert.match(h.text(), /Credential storage/);
  h.input(up, enter, enter, enter); await tick();
  assert.equal(h.saves.length, 2); assert.equal(h.saves[1]!.draft.storage, "file");
  assert.deepEqual(h.done, [true]);
});

test("arbitrary save failures never reach the panel, and disposal suppresses late updates", async () => {
  let reject!: (error: Error) => void;
  const h = harness({}, () => new Promise<void>((_resolve, fail) => { reject = fail; }));
  toKey(h); h.input("fixture", enter, enter);
  h.panel.dispose(); reject(new Error("fixture-private-diagnostic")); await tick();
  assert.doesNotMatch(h.text(), /fixture-private-diagnostic/); assert.deepEqual(h.done, []);
});

test("modal is compact and centered, all stages stay within resized bounds and summary scrolls", () => {
  assert.deepEqual(SETUP_OVERLAY, { width: 72, minWidth: 32, maxHeight: "85%", anchor: "center", margin: 1 });
  assert.equal(setupRows(60), 22); assert.ok(setupRows(24) < 24);
  const h = harness();
  for (let step = 0; step < 8; step++) {
    for (const rows of [12, 16, 22]) for (const width of [32, 40, 48, 72]) {
      h.rows(rows);
      const lines = h.panel.render(width);
      assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.at(-1)!, /╯$/);
      assert.match(lines.join("\n"), /Esc cancel/);
    }
    h.rows(22);
    if (h.text().includes("Review changes")) break;
    if (h.text().includes("Credential storage")) h.input(down);
    if (h.text().includes("Enter the gemini API key")) h.input("fixture");
    h.input(enter);
  }
  h.rows(12); const before = h.text(32);
  for (let i = 0; i < 100; i++) h.panel.handleInput(down);
  const after = h.text(32);
  assert.notEqual(after, before); assert.match(after, /error will say so/);
  assert.equal(h.saves.length, 0);
});

test("tiny terminals block edits while allowing cancellation and recover after resize", () => {
  const h = harness(); h.rows(5);
  assert.match(h.text(10), /Web access/);
  h.panel.handleInput(enter); h.rows(22);
  assert.match(h.text(), /Search provider/);
  h.rows(5); h.text(10); h.panel.handleInput(escape); assert.deepEqual(h.done, [false]);
});

test("configured confirm and selection keybindings are honored", () => {
  const snapshot: SetupSnapshot = { root: {}, agentDir: "/tmp", config: parseConfig({}, "/tmp") };
  const panel = new SetupPanel({ theme, snapshot, keybindings: { matches: (data: string, id: string) => data === ({ "tui.select.down": "j", "tui.select.confirm": "f" } as Record<string, string>)[id] } as never, maxRows: () => 22, onRender: () => {}, onSave: async () => {}, onDone: () => {} });
  panel.handleInput("j"); panel.handleInput("f"); panel.handleInput("f");
  assert.match(stripVTControlCharacters(panel.render(72).join("\n")), /gpt-5-mini/);
});

const diagnosticTab = "\t";
test("Tab and Shift+Tab switch sections, never wizard steps or provider selection", async () => {
  const h = harness(); await tick();
  h.input(down, diagnosticTab);
  assert.match(h.text(), /Refresh checks/);
  h.input("\x1b[Z");
  assert.match(h.text(), /Search provider/);
  h.input(enter, enter);
  assert.match(h.text(), /gpt-5-mini/); // OpenAI selection survived both tab switches.
  h.input("\x1b[Z"); assert.match(h.text(), /Refresh checks/);
  h.input(diagnosticTab); assert.match(h.text(), /Native search model/);
  h.input(back); assert.match(h.text(), /Web access tools/);
  assert.equal(h.saves.length, 0);
  h.input(escape);
});
test("masked secret survives Diagnostic tab switches without being rendered or saved early", async () => {
  const h = harness(); toKey(h); h.input("fixture-private-key"); await tick();
  h.input(diagnosticTab); assert.doesNotMatch(h.text(), /fixture-private-key/);
  h.input(diagnosticTab); assert.doesNotMatch(h.text(), /fixture-private-key/);
  assert.match(h.text(), /API key/); assert.equal(h.saves.length, 0);
  h.input(enter, enter); await tick();
  assert.equal(h.saves[0]?.key, "fixture-private-key"); assert.deepEqual(h.done, [true]);
});
test("Diagnostic opens with lightweight checks only, refreshes and runs a test only on explicit action", async () => {
  let inspections = 0, tests = 0;
  let finish!: (result: RenderProbeResult) => void;
  const h = harness({}, undefined, {
    inspect: async () => { inspections++; return { checks: [{ label: "Classic HTTP", state: "untested", summary: "No HTTP request made" }], remedies: ["manual command"] }; },
    testRender: () => { tests++; return new Promise((resolve) => { finish = resolve; }); },
  });
  await tick(); assert.equal(inspections, 1); assert.equal(tests, 0);
  h.input(diagnosticTab); assert.match(h.text(), /No HTTP request made/);
  h.input(enter); await tick(); assert.equal(inspections, 2); assert.equal(tests, 0);
  h.input("\x1b[200~", "t\r", "\x1b[201~"); assert.equal(tests, 0);
  h.input("t", "t", "r", enter); assert.equal(tests, 1); assert.equal(inspections, 2);
  assert.match(h.text(), /Testing isolated rendering/);
  finish({ state: "passed", summary: "Synthetic JS passed; HTTP untested" }); await tick();
  assert.match(h.text(), /PASSED: Synthetic JS/);
  h.input("r"); await tick(); assert.doesNotMatch(h.text(), /PASSED/);
  h.input(diagnosticTab); assert.match(h.text(), /Search provider/);
  assert.equal(h.saves.length, 0);
});
test("Diagnostic cancellation/disposal aborts test and suppresses late completion; draft survives tab switch", async () => {
  let signal!: AbortSignal, finish!: (result: RenderProbeResult) => void;
  const h = harness({}, undefined, { testRender: (s) => { signal = s; return new Promise((resolve) => { finish = resolve; }); } });
  h.input(down, enter, enter, "\x15", "custom-model"); await tick();
  h.input(diagnosticTab, "t", "c"); assert.equal(signal.aborted, true);
  assert.match(h.text(), /Cancelling/);
  finish({ state: "passed", summary: "late success" }); await tick();
  assert.match(h.text(), /CANCELLED/); assert.doesNotMatch(h.text(), /late success/);
  h.input(diagnosticTab); assert.match(h.text(), /custom-model/);
  h.input(diagnosticTab, "t", escape); assert.equal(signal.aborted, true); assert.deepEqual(h.done, [false]);
  finish({ state: "passed", summary: "late success" }); await tick(); assert.doesNotMatch(h.text(), /late success/);
});
test("Diagnostic failures are sanitized, refresh is recoverable, bounds and scrolling hold", async () => {
  let fail = true;
  const h = harness({}, undefined, {
    inspect: async () => { if (fail) throw new Error("private-host-secret"); return { checks: [], remedies: Array.from({ length: 20 }, (_, i) => `Manual command ${i}`) }; },
    testRender: async () => { throw new Error("private-render-secret"); },
  });
  h.input(diagnosticTab); await tick(); assert.match(h.text(), /Local inspection failed/); assert.doesNotMatch(h.text(), /private-host/);
  fail = false; h.input("r"); await tick();
  h.input("t"); await tick(); assert.match(h.text(), /cause unknown/); assert.doesNotMatch(h.text(), /private-render/);
  for (const width of [32, 40, 72]) for (const rows of [12, 16, 22]) {
    h.rows(rows); const lines = h.panel.render(width);
    assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length}`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  h.rows(22); for (let i = 0; i < 100; i++) h.input(down);
  assert.match(h.text(), /Manual command 19/);
  h.input(escape);
});
