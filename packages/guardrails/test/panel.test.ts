import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Theme, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { GuardrailsPanel, initialPanelState, panelRows, decisionIcon, type PanelState } from "../src/tui/panel.js";
import { HistoryStore } from "../src/history.js";
import { config, entry } from "./helpers.js";

function nativeTheme(name: string): Theme {
  const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
  const json = JSON.parse(readFileSync(join(root, "modes/interactive/theme", `${name}.json`), "utf8"));
  const colors = Object.fromEntries(Object.entries(json.colors).map(([key, value]) => [key, typeof value === "string" && json.vars?.[value] !== undefined ? json.vars[value] : value]));
  return new Theme(colors as any, colors as any, "truecolor");
}
const kb = { matches: (data: string, key: string) => ({ "tui.select.cancel": matchesKey(data, "escape"), "tui.select.confirm": matchesKey(data, "enter"), "tui.select.up": matchesKey(data, "up"), "tui.select.down": matchesKey(data, "down") })[key] ?? false } as KeybindingsManager;
function fixture(theme: Theme, terminalRows: number, state: PanelState = initialPanelState()) {
  const history = new HistoryStore(":memory:");
  history.put(entry({ summary: "git status", actor: { kind: "subagent", runId: "run-42", profile: "reviewer" }, state: "denied", action: "Ask", reason: "Worker Ask is blocked. Try a safe alternative or report the blocker.", execution: "blocked" }));
  history.put(entry({ summary: "read /project/README.md", tool: "read", choice: "allow-once" }));
  history.put(entry({ summary: "git diff --stat", state: "review", action: "Ask" }));
  let done = "";
  const draft = config();
  const panel = new GuardrailsPanel({ theme, keybindings: kb, history, draft, snapshot: { config: draft, policies: draft.policies, revision: "test", projectStatus: "No project policies" }, state, sessionId: "parent-1", maxRows: () => panelRows(terminalRows), model: () => "openai-codex/example-model", onRender() {}, onDone: (a) => { done = a.type; } });
  return { panel, history, state, draft, done: () => done };
}
test("native dark/light render fills available height and never exceeds width, including narrow and small terminals", () => {
  for (const name of ["dark", "light"]) for (const [width, height] of [[144, 45], [90, 30], [45, 24], [32, 16], [20, 8]]) {
    for (const tab of ["Setup", "Policies", "History"] as const) {
      const f = fixture(nativeTheme(name), height, { ...initialPanelState(), tab });
      try {
        const lines = f.panel.render(width); assert.ok(lines.length <= panelRows(height));
        if (width >= 32 && panelRows(height) >= 12) assert.equal(lines.length, panelRows(height));
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${name} ${tab} ${width}: ${line}`);
        if (width === 144 && tab === "History") {
          const text = lines.map(stripVTControlCharacters).join("\n");
          assert.match(text, /Current session/); assert.match(text, /Global/); assert.match(text, /Subagent/);
          assert.doesNotMatch(text, /Approved|Review ·|Blocked ·/);
          if (name === "dark" && process.env.GUARDRAILS_RENDER_FIXTURE) writeFileSync(process.env.GUARDRAILS_RENDER_FIXTURE, text + "\n", { mode: 0o600 });
        }
      } finally { f.panel.dispose(); f.history.close(); }
    }
  }
});
test("live events preserve selected row/order and show a new-event indicator until refresh", () => {
  const f = fixture(nativeTheme("dark"), 30, { ...initialPanelState(), tab: "History" });
  try {
    f.panel.render(120); f.panel.handleInput("\x1b[B"); f.panel.render(120);
    const selected = f.state.selectedId;
    f.history.put(entry({ summary: "brand new action", at: Date.now() + 1000 }));
    const text = f.panel.render(120).map(stripVTControlCharacters).join("\n");
    assert.equal(f.state.selectedId, selected); assert.match(text, /\+1 new/); assert.doesNotMatch(text, /brand new action/);
    f.panel.handleInput("n"); f.panel.render(120); assert.equal(f.state.selectedId, selected);
    f.panel.handleInput("a"); assert.equal(f.state.filter.actor, "main");
    f.panel.handleInput("d"); assert.equal(f.state.filter.decision, "auto");
    f.panel.handleInput("/"); f.panel.handleInput("git"); f.panel.handleInput("\r"); assert.equal(f.state.filter.search, "git");
    f.panel.handleInput("g"); assert.equal(f.state.global, true);
  } finally { f.panel.dispose(); f.history.close(); }
});
test("narrow Enter detail is scrollable; tabs and staged settings use native keyboard handling", () => {
  const f = fixture(nativeTheme("light"), 24, { ...initialPanelState(), tab: "History" });
  try {
    f.panel.render(45); f.panel.handleInput("\r"); assert.equal(f.state.detail, true);
    f.panel.handleInput("\x1b[6~"); assert.ok(f.state.scroll > 0);
    assert.ok(f.panel.render(45).every((l) => visibleWidth(l) <= 45));
    f.panel.handleInput("\x1b"); assert.equal(f.state.detail, false);
    f.panel.handleInput("\t"); assert.equal(f.state.tab, "Setup");
    f.panel.handleInput("\r"); assert.equal(f.draft.enabled, false); assert.equal(f.done(), "");
    f.panel.handleInput("\x1b[200~\x13\r\x1b[201~"); assert.equal(f.done(), "", "paste must not save");
    f.panel.handleInput("\x13"); assert.equal(f.done(), "save");
  } finally { f.panel.dispose(); f.history.close(); }
});
test("decision rows use semantic icon colors, including human-approved accent rather than auto success", () => {
  const calls: string[] = [];
  const theme = { fg: (color: string, text: string) => { calls.push(color); return text; } } as Theme;
  assert.equal(decisionIcon(entry(), theme), "✓");
  assert.equal(decisionIcon(entry({ choice: "allow-once" }), theme), "✓");
  assert.equal(decisionIcon(entry({ state: "review" }), theme), "!");
  assert.equal(decisionIcon(entry({ state: "denied" }), theme), "✕");
  assert.deepEqual(calls, ["success", "accent", "warning", "error"]);
});
