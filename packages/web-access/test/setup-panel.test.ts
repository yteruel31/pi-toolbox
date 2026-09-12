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
const enter = "\r", down = "\x1b[B", up = "\x1b[A", escape = "\x1b", tab = "\t", reverseTab = "\x1b[Z";
function harness(root: Record<string, unknown> = {}, save?: (draft: SetupDraft, key?: string) => Promise<void>, diagnostics: { inspect?: () => Promise<DiagnosticReport>; testRender?: (signal: AbortSignal) => Promise<RenderProbeResult> } = {}) {
  const snapshot: SetupSnapshot = { agentDir: "/tmp/not-used", root, config: parseConfig(root, "/tmp/not-used") };
  const saves: Array<{ draft: SetupDraft; key?: string }> = [], done: boolean[] = [];
  let rows = 22;
  const panel = new SetupPanel({ inspect: async () => ({ checks: [], remedies: [] }), ...diagnostics, theme, keybindings: kb, snapshot, maxRows: () => rows, onRender: () => {}, onDone: (saved) => done.push(saved), onSave: async (draft, key) => { saves.push({ draft, key }); await save?.(draft, key); } });
  panel.focused = true;
  const input = (...keys: string[]) => { for (const key of keys) { panel.render(72); panel.handleInput(key); } };
  const text = (width = 72) => stripVTControlCharacters(panel.render(width).join("\n")).replaceAll("\x1b_pi:c\x07", "");
  const select = (label: string) => {
    for (let i = 0; i < 10; i++) { if (text().includes(`▸ ${label}:`)) return; input(down); }
    assert.fail(`Missing field ${label}: ${text()}`);
  };
  const edit = (label: string) => { select(label); input(enter); };
  return { panel, saves, done, input, text, select, edit, rows: (value: number) => { rows = value; } };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function toKey(h: ReturnType<typeof harness>, keyring = false) {
  h.edit("Credential storage"); h.input(down, ...(keyring ? [down] : []), enter); h.edit("API key");
}
function review(h: ReturnType<typeof harness>) { h.edit("Review changes"); }

test("secret entry masks every render, supports editing and never serializes its value", () => {
  const input = new SecretInput(); input.focused = true; input.handleInput("fixture-abc");
  for (const width of [1, 2, 8, 32, 80]) {
    const lines = input.render(width); assert.ok(lines.every((line) => visibleWidth(line) <= width)); assert.doesNotMatch(lines.join(""), /fixture|abc/);
  }
  assert.doesNotMatch(JSON.stringify(input), /fixture/);
  input.handleInput("\x1b[D"); input.handleInput("\x7f"); assert.equal(input.getValue(), "fixture-ac");
  input.handleInput("\x1b[3~"); assert.equal(input.getValue(), "fixture-a");
  input.handleInput("\x15"); input.handleInput("\x19"); assert.equal(input.getValue(), "");
  input.handleInput("fixture"); input.dispose(); assert.equal(input.getValue(), "");
});
test("secret paste and terminal protocols preserve printable input but never shortcuts", () => {
  const input = new SecretInput(); input.handleInput("\x1b[200~fixture-$;`"); input.handleInput("abc\x1b[20"); input.handleInput("1~\r");
  assert.equal(input.getValue(), "fixture-$;`abc"); input.handleInput("\x1b[120u"); assert.equal(input.getValue(), "fixture-$;`abcx");
  input.handleInput("\x1b[27;2;65~"); input.handleInput("\x1b[27;1;98~"); input.handleInput("\x1b[27;66;67~");
  assert.equal(input.getValue(), "fixture-$;`abcxAbC");
  for (const modifier of [3, 4, 5, 6, 9, 17]) input.handleInput(`\x1b[27;${modifier};120~`);
  assert.equal(input.getValue(), "fixture-$;`abcxAbC");
  input.handleInput("\x1b[200~bad\r\nkey\x1b[201~"); assert.equal(input.invalid, true);
  input.clear(); input.handleInput("\x1b[200~" + "x".repeat(17000)); input.handleInput("\x1b[201~");
  assert.equal(input.invalid, true); assert.equal(input.getValue(), "");
});
test("Setup is a selectable form, not a sequence; Tab and Shift+Tab only switch sections", async () => {
  const h = harness(); await tick();
  assert.match(h.text(), /Settings/); assert.match(h.text(), /Search provider: gemini/);
  assert.doesNotMatch(h.text(), /Alt\+Left|Enter next|\d\/\d/);
  h.select("Native deep research model");
  h.input(tab); assert.match(h.text(), /Refresh checks/);
  h.input(reverseTab); assert.match(h.text(), /▸ Native deep research model:/);
  assert.equal(h.saves.length, 0); h.input(escape);
});
test("fields can be edited in any order, tab switches preserve editing, Esc cancels a field", async () => {
  const h = harness(); await tick(); h.edit("Native deep research model");
  h.input("\x15", "custom-research", tab); assert.match(h.text(), /Refresh checks/);
  h.input(reverseTab); assert.match(h.text(), /custom-research/);
  h.input(enter); assert.match(h.text(), /Settings/);
  h.edit("Search provider"); h.input(down, escape); // Discard OpenAI selection.
  assert.match(h.text(), /Search provider: gemini/);
  h.edit("Native search model"); h.input("\x15", "discard-me", escape);
  h.edit("Native search model"); assert.doesNotMatch(h.text(), /discard-me/); h.input(escape);
  h.input(tab, tab); assert.match(h.text(), /Settings/);
  h.input(reverseTab, reverseTab); assert.match(h.text(), /Settings/);
  assert.equal(h.saves.length, 0); h.input(escape, enter); assert.deepEqual(h.done, [false]);
});
test("applied native model edits survive a provider round trip without reusing credentials", async () => {
  const h = harness();
  h.edit("Native search model"); h.input("\x15", "custom-gemini-search", enter);
  h.edit("Native deep research model"); h.input("\x15", "custom-gemini-research", enter);
  h.edit("Search provider"); h.input(down, enter);
  h.edit("Native search model"); h.input("\x15", "custom-openai-search", enter);
  h.edit("Search provider"); h.input(up, enter);
  h.edit("Native search model"); assert.match(h.text(), /custom-gemini-search/); h.input(escape);
  h.edit("Native deep research model"); assert.match(h.text(), /custom-gemini-research/); h.input(escape);
  h.edit("Search provider"); h.input(down, enter);
  h.edit("Native search model"); assert.match(h.text(), /custom-openai-search/); h.input(escape);
  review(h); h.input(enter); await tick(); assert.equal(h.saves[0]?.draft.searchModel, "custom-openai-search");
});
test("applying a field does not advance, save or require an alternate navigation key", () => {
  const h = harness(); h.edit("Search provider"); h.input(down, enter);
  assert.match(h.text(), /▸ Search provider: openai/);
  h.input("\x1b[1;3D"); assert.match(h.text(), /▸ Search provider: openai/);
  h.edit("Web access tools"); h.input(down, enter); assert.match(h.text(), /Web access tools: Disabled/);
  assert.equal(h.saves.length, 0); h.input(escape);
});
test("file credentials need explicit review and save, stay masked across tabs and cannot be omitted", async () => {
  const h = harness({ credentials: { gemini: "do-not-display-literal" } });
  toKey(h); h.input(escape); review(h); h.input(enter);
  assert.equal(h.saves.length, 0); assert.match(h.text(), /Enter a non-empty API key/);
  h.input("fixture-private-key", tab); assert.doesNotMatch(h.text(), /fixture-private-key|do-not-display-literal/);
  h.input(reverseTab, enter); assert.match(h.text(), /Settings/);
  assert.doesNotMatch(JSON.stringify(h.panel), /fixture-private-key|do-not-display-literal/);
  review(h); assert.equal(h.saves.length, 0); assert.match(h.text(), /entered \(hidden\)/);
  h.input(enter, enter); await tick();
  assert.equal(h.saves.length, 1); assert.equal(h.saves[0]?.key, "fixture-private-key"); assert.deepEqual(h.done, [true]);
});
test("cancelling secret edits restores the staged value; provider changes clear it", async () => {
  const h = harness(); toKey(h); h.input("original-key", enter);
  h.edit("API key"); h.input("\x15", "discarded-key", escape);
  review(h); h.input(enter); await tick(); assert.equal(h.saves[0]?.key, "original-key");
  const other = harness(); toKey(other); other.input("fixture-key", enter);
  other.edit("Search provider"); other.input(down, enter); review(other); other.input(enter);
  assert.equal(other.saves.length, 0); assert.match(other.text(), /Enter a non-empty API key/);
  other.input(escape, escape);
});
test("Brave hides native model fields, keeping synthesis and credential selection independent", async () => {
  const h = harness({ search: { provider: "brave" }, synthesisModel: "anthropic/fixture-model" });
  assert.doesNotMatch(h.text(), /Native search model:|Native deep research model:/);
  h.edit("Pi synthesis model"); assert.match(h.text(), /Brave has no native/); h.input(enter);
  review(h); h.input(enter); await tick();
  assert.equal(h.saves[0]?.draft.provider, "brave"); assert.equal(h.saves[0]?.draft.storage, "keep"); assert.equal(h.saves[0]?.key, undefined);
});
test("model validation and chunked pastes never navigate, save or switch tabs", () => {
  const h = harness(); h.input("\x1b[200~", "\t\r", "\x1b[201~"); assert.match(h.text(), /Settings/);
  h.edit("Native search model"); h.input("\x15", "bad model", enter); assert.match(h.text(), /Use a model ID/);
  h.input("\x1b[200~", "\t\r", "\x1b[201~"); assert.match(h.text(), /Paste rejected/);
  h.input(escape); toKey(h); h.input("\x1b[200~", "\t\r", "\x1b[201~", enter);
  assert.equal(h.saves.length, 0); assert.match(h.text(), /Enter a non-empty API key/);
  h.input(escape, escape);
});
test("keyring failure allows an intentional storage edit and retry, with no automatic fallback", async () => {
  const h = harness({}, async (draft) => { if (draft.storage === "keyring") throw new SetupError("keyring"); });
  toKey(h, true); h.input("fixture", enter); review(h); h.input(enter); await tick();
  assert.match(h.text(), /libsecret-tools/); assert.equal(h.saves.length, 1);
  h.input(enter, up, enter); review(h); h.input(enter); await tick();
  assert.equal(h.saves[1]?.draft.storage, "file"); assert.deepEqual(h.done, [true]);
});
test("save failures stay sanitized and disposal suppresses late updates", async () => {
  let reject!: (error: Error) => void;
  const h = harness({}, () => new Promise<void>((_resolve, fail) => { reject = fail; }));
  review(h); h.input(enter); h.panel.dispose(); reject(new Error("private-diagnostic")); await tick();
  assert.doesNotMatch(h.text(), /private-diagnostic/); assert.deepEqual(h.done, []);
});
test("form, editors, review and Diagnostic fit small terminals with visible tab controls", async () => {
  assert.deepEqual(SETUP_OVERLAY, { width: 72, minWidth: 32, maxHeight: "85%", anchor: "center", margin: 1 });
  assert.equal(setupRows(60), 22);
  const h = harness(); await tick();
  const bounds = () => {
    for (const rows of [12, 16, 22]) for (const width of [32, 40, 72]) {
      h.rows(rows); const lines = h.panel.render(width);
      assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length}`);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.match(lines.join("\n"), /Tab\/Shift\+Tab/); assert.match(lines.at(-1)!, /╯$/);
    }
    h.rows(22);
  };
  bounds();
  for (const field of ["Search provider", "Web access tools", "Native search model", "Native deep research model", "Pi synthesis model", "Credential storage", "Review changes"]) {
    h.edit(field); bounds(); h.input(escape);
  }
  toKey(h); bounds(); h.input(escape, tab); bounds(); h.input(tab);
  review(h); h.rows(12); for (let i = 0; i < 100; i++) { h.text(32); h.panel.handleInput(down); } assert.match(h.text(32), /error will say so/);
  h.rows(5); assert.match(h.text(10), /Web access/); h.input(escape); h.rows(22); h.input(escape); assert.deepEqual(h.done, [false]);
});
test("configured field selection and confirm keys are honored", () => {
  const snapshot: SetupSnapshot = { root: {}, agentDir: "/tmp", config: parseConfig({}, "/tmp") };
  const panel = new SetupPanel({ theme, snapshot, inspect: async () => ({ checks: [], remedies: [] }), keybindings: { matches: (data: string, id: string) => data === ({ "tui.select.down": "j", "tui.select.confirm": "f" } as Record<string, string>)[id] } as never, maxRows: () => 22, onRender: () => {}, onSave: async () => {}, onDone: () => {} });
  panel.handleInput("f"); panel.handleInput("j"); panel.handleInput("f");
  assert.match(stripVTControlCharacters(panel.render(72).join("\n")), /Search provider: openai/); panel.dispose();
});
test("Diagnostic only launches a render on explicit action, prevents repeats, and refresh clears results", async () => {
  let inspections = 0, tests = 0, finish!: (result: RenderProbeResult) => void;
  const h = harness({}, undefined, {
    inspect: async () => { inspections++; return { checks: [{ label: "Classic HTTP", state: "untested", summary: "No HTTP request made" }], remedies: [] }; },
    testRender: () => { tests++; return new Promise((resolve) => { finish = resolve; }); },
  });
  await tick(); assert.equal(inspections, 1); assert.equal(tests, 0); h.input(tab); assert.match(h.text(), /No HTTP request made/);
  h.input(enter); await tick(); assert.equal(inspections, 2);
  h.input("\x1b[200~", "t\r\t", "\x1b[201~"); assert.equal(tests, 0);
  h.input("t", "t", "r", enter); assert.equal(tests, 1); assert.equal(inspections, 2); assert.match(h.text(), /Testing isolated rendering/);
  finish({ state: "passed", summary: "Synthetic JS passed; HTTP untested" }); await tick(); assert.match(h.text(), /PASSED: Synthetic JS/);
  h.input("r"); await tick(); assert.doesNotMatch(h.text(), /PASSED/); h.input(tab, escape);
});
test("Diagnostic cancellation and disposal abort the test and ignore late success", async () => {
  let signal!: AbortSignal, finish!: (result: RenderProbeResult) => void;
  const h = harness({}, undefined, { testRender: (s) => { signal = s; return new Promise((resolve) => { finish = resolve; }); } });
  await tick(); h.input(tab, "t", "c"); assert.equal(signal.aborted, true); assert.match(h.text(), /Cancelling/);
  finish({ state: "passed", summary: "late success" }); await tick(); assert.match(h.text(), /CANCELLED/); assert.doesNotMatch(h.text(), /late success/);
  h.input("t", escape); assert.equal(signal.aborted, true); assert.deepEqual(h.done, [false]);
  finish({ state: "passed", summary: "late success" }); await tick(); assert.doesNotMatch(h.text(), /late success/);
});
test("Diagnostic failures are sanitized and recoverable, remedies scroll", async () => {
  let fail = true;
  const h = harness({}, undefined, {
    inspect: async () => { if (fail) throw new Error("private-host-secret"); return { checks: [], remedies: Array.from({ length: 20 }, (_, i) => `Manual command ${i}`) }; },
    testRender: async () => { throw new Error("private-render-secret"); },
  });
  h.input(tab); await tick(); assert.match(h.text(), /Local inspection failed/); assert.doesNotMatch(h.text(), /private-host/);
  fail = false; h.input("r"); await tick(); h.input("t"); await tick(); assert.match(h.text(), /cause unknown/); assert.doesNotMatch(h.text(), /private-render/);
  for (let i = 0; i < 100; i++) h.input(down); assert.match(h.text(), /Manual command 19/); h.input(escape);
});
