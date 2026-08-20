import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { normalizeAsk } from "../src/contracts.ts";
import { buildResult, createAskState, selectDeclared, setCustomText, setOptionNote } from "../src/domain.ts";
import { editorBindingHint, formatCallTranscript, formatResultTranscript, renderAsk } from "../src/render.ts";

const theme = new Proxy({}, { get: (_target, property) => property === "bold" ? (text: string) => text : (_color: string, text: string) => text }) as any;
const view = { mode: "main" as const, configPath: "/tmp/config.json" };

test("single question rendering uses ASCII tabs and subtle panel dividers", () => {
  const form = normalizeAsk({ title: "Decision", questions: [{ id: "q", label: "Scope", prompt: "Choose scope", options: [{ value: "small", label: "Small", description: "Low risk", recommended: true }] }] }).form!;
  const state = createAskState(form);
  const lines = renderAsk(state, DEFAULT_CONFIG, theme, 80, view);
  const text = lines.join("\n");
  assert.match(text, /Decision \(ask_user\)/);
  assert.match(text, /- Scope/);
  assert.match(text, /\* Submit/);
  assert.match(text, /⇆ tab/);
  assert.match(lines[1]!, /^─{80}$/);
  assert.match(lines[3]!, /^─{80}$/);
  assert.match(lines.at(-3)!, /^─{80}$/);
  assert.match(lines.at(-1)!, /^─{80}$/);
  assert.match(text, /\(recommended\) \| Low risk/);
  assert.match(text, /2\. Type your own/);
  selectDeclared(state, form.questions[0]!, "small");
  assert.match(renderAsk(state, DEFAULT_CONFIG, theme, 80, view).join("\n"), /\+ Scope/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 80));
});

test("long questions use a bounded viewport with sticky navigation and scroll hints", () => {
  const prompt = Array.from({ length: 30 }, (_, index) => `Question detail ${index + 1}`).join("\n");
  const form = normalizeAsk({ title: "Long decision", questions: [{ id: "q", label: "Scope", prompt, options: [{ value: "a", label: "A" }] }] }).form!;
  const state = createAskState(form);
  const initial = renderAsk(state, DEFAULT_CONFIG, theme, 60, { ...view, maxHeight: 14, scrollOffset: 0 });
  assert.equal(initial.length, 14);
  assert.match(initial.join("\n"), /Long decision \(ask_user\)/);
  assert.match(initial.join("\n"), /↓ .*more lines? · Shift\+↓/);
  assert.match(initial.at(-2)!, /Shift\+↑\/↓ scroll/);
  assert.match(initial.at(-1)!, /^─{60}$/);

  const scrolled = renderAsk(state, DEFAULT_CONFIG, theme, 60, { ...view, maxHeight: 14, scrollOffset: 5 });
  assert.equal(scrolled.length, 14);
  assert.match(scrolled.join("\n"), /↑ 5 more lines · Shift\+↑/);
  assert.match(scrolled.join("\n"), /↓ .*more lines? · Shift\+↓/);
  assert.match(scrolled.join("\n"), /- Scope/);
});

test("the panel keeps a bottom boundary when footer hints are hidden", () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] }).form!;
  const config = structuredClone(DEFAULT_CONFIG);
  config.behaviour.showFooterHints = false;
  const lines = renderAsk(createAskState(form), config, theme, 40, view);
  assert.match(lines.at(-1)!, /^─{40}$/);
  assert.doesNotMatch(lines.join("\n"), /⇆ tab/);
});

test("preview rendering uses a complete split pane on wide terminals", () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Style?", type: "preview", options: [{ value: "a", label: "Minimal", description: "Short", preview: "Example output here" }] }] }).form!;
  const lines = renderAsk(createAskState(form), DEFAULT_CONFIG, theme, 100, view);
  const text = lines.join("\n");
  assert.match(text, /Example output here/);
  assert.match(text, /┌─+┐/);
  assert.match(text, /│/);
  assert.match(text, /└─+┘/);
  assert.ok(lines.every((line) => visibleWidth(line) <= 100));
});

test("narrow previews stack below options and custom row suppresses preview", () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Style?", type: "preview", options: [{ value: "a", label: "Minimal", preview: "Narrow example" }] }] }).form!;
  const state = createAskState(form);
  const narrow = renderAsk(state, DEFAULT_CONFIG, theme, 40, view).join("\n");
  assert.ok(narrow.indexOf("Narrow example") > narrow.indexOf("2. Type your own"));
  state.cursor = 1;
  assert.doesNotMatch(renderAsk(state, DEFAULT_CONFIG, theme, 100, view).join("\n"), /Narrow example/);
  assert.doesNotMatch(renderAsk(state, DEFAULT_CONFIG, theme, 40, view).join("\n"), /Narrow example/);
});

test("review expands unselected notes for Elaborate", () => {
  const form = normalizeAsk({ questions: [{ id: "q", label: "Q", prompt: "Q?", type: "multi", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }).form!;
  const state = createAskState(form);
  selectDeclared(state, form.questions[0]!, "a");
  setOptionNote(state, "q", "b", "why not");
  state.tab = 1;
  state.reviewCursor = 1;
  assert.match(renderAsk(state, DEFAULT_CONFIG, theme, 80, view).join("\n"), /B Note: why not/);
});

test("review resolves notes by canonical value/index and renders every selection", () => {
  const options = Array.from({ length: 35 }, (_, index) => ({ value: `v${index}`, label: index < 2 ? "Duplicate" : `Option ${index}` }));
  const form = normalizeAsk({ questions: [{ id: "q", label: "Q", prompt: "Q?", type: "multi", options }] }).form!;
  const state = createAskState(form);
  selectDeclared(state, form.questions[0]!, "v1");
  selectDeclared(state, form.questions[0]!, "v34");
  setOptionNote(state, "q", "v1", "second duplicate note");
  state.tab = 1;
  const text = renderAsk(state, DEFAULT_CONFIG, theme, 80, view).join("\n");
  assert.match(text, /second duplicate note/);
  assert.match(text, /Option 34/);
});

test("committed freeform answers stay visible and tiny widths are respected", () => {
  const form = normalizeAsk({ questions: [{ id: "open", prompt: "Explain", freeform: true, options: [] }] }, { allowInternalFreeform: true }).form!;
  const state = createAskState(form);
  setCustomText(state, form.questions[0]!, "A committed answer");
  assert.match(renderAsk(state, DEFAULT_CONFIG, theme, 40, view).join("\n"), /A committed answer/);
  for (const width of [1, 5, 12, 19]) {
    assert.ok(renderAsk(state, DEFAULT_CONFIG, theme, width, view).every((line) => visibleWidth(line) <= width));
  }
});

test("settings visibly identifies this package namespace", () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] }).form!;
  const settingsView = { ...view, mode: "settings" as const, settingsCursor: 0 };
  assert.match(renderAsk(createAskState(form), DEFAULT_CONFIG, theme, 80, settingsView).join("\n"), /@yteruel31\/pi-ask/);
});

test("editor hints reflect live bindings", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.keymaps.editor.submit = ["ctrl+s"];
  config.keymaps.editor.close = ["ctrl+x"];
  config.keymaps.noteEditor.save = ["alt+s"];
  assert.equal(editorBindingHint(config, "submit"), "Ctrl+S submit · Ctrl+X close");
  assert.equal(editorBindingHint(config, "save"), "Alt+S save · Esc close");
});

test("transcript helpers are compact and include unanswered questions", () => {
  const form = normalizeAsk({ title: "T", questions: [{ id: "q", label: "Q", prompt: "Q?", options: [{ value: "a", label: "A" }] }, { id: "u", label: "U", prompt: "U?", options: [{ value: "b", label: "B" }] }] }).form!;
  const state = createAskState(form);
  selectDeclared(state, form.questions[0]!, "a");
  const result = buildResult(state, "submit");
  assert.equal(formatCallTranscript({ title: "T", questions: [{}, {}] }), "ask_user 2 questions · T");
  assert.deepEqual(formatResultTranscript(result.details), ["✓ Q: A", "? U: (no answer)"]);
  assert.deepEqual(formatResultTranscript({ cancelled: true }), ["Cancelled"]);
  assert.deepEqual(formatResultTranscript({ error: {} }), ["Invalid tool payload"]);
});

test("elaboration transcript states the full note target directly", () => {
  const form = normalizeAsk({ questions: [{ id: "q", label: "Q", prompt: "Which option?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }).form!;
  const state = createAskState(form);
  selectDeclared(state, form.questions[0]!, "a");
  setOptionNote(state, "q", "b", "why not?");
  const result = buildResult(state, "elaborate");
  assert.deepEqual(formatResultTranscript(result.details), [
    '↻ User asked to elaborate on question "Which option?" option "B" with note "why not?"; current answer: A',
  ]);
});
