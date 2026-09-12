import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { DiagnosticReport, RedditDiagnosticResult, RenderProbeResult } from "../src/diagnostics.js";
import { DiagnosticView } from "../src/tui/diagnostic-view.js";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const kb = { matches: (data: string, id: string) => matchesKey(data, ({ "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down" } as Record<string, string>)[id] as never) } as never;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reddit = (status: RedditDiagnosticResult["diagnostic"]["status"], options: { enabled?: boolean; at?: string } = {}): RedditDiagnosticResult => ({
  enabled: options.enabled ?? true,
  diagnostic: { status, eligible: status === "ready", message: `Safe ${status} guidance.`, lastValidatedAt: options.at },
});
const report = (remedies = 0): DiagnosticReport => ({
  checks: [
    { label: "Classic HTTP fetch", state: "untested", summary: "No request was made." },
    { label: "Bubblewrap", state: "observed", summary: "Found locally; not launched." },
  ],
  remedies: Array.from({ length: remedies }, (_, index) => `Manual remedy ${index}`),
});
function harness(options: {
  inspectWeb?: () => Promise<DiagnosticReport>;
  inspectReddit?: () => Promise<RedditDiagnosticResult>;
  testRender?: (signal: AbortSignal) => Promise<RenderProbeResult>;
  testReddit?: (signal: AbortSignal) => Promise<RedditDiagnosticResult>;
} = {}) {
  let renders = 0;
  const view = new DiagnosticView({
    theme, keybindings: kb, onRender: () => { renders++; }, now: () => new Date("2026-09-18T12:34:56Z"),
    inspectWeb: options.inspectWeb ?? (async () => report()),
    inspectReddit: options.inspectReddit ?? (async () => reddit("not_configured")),
    testRender: options.testRender,
    testReddit: options.testReddit,
  });
  const lines = (width = 80, rows = 24) => view.render(width, rows);
  const text = (width = 80, rows = 24) => stripVTControlCharacters(lines(width, rows).join("\n"));
  return { view, lines, text, renders: () => renders };
}

test("default view is concise, themed by status, and keeps external tests and Reddit browser distinct", async () => {
  let renderTests = 0, redditTests = 0;
  const h = harness({
    inspectReddit: async () => reddit("ready", { at: "2026-09-17T01:02:03Z" }),
    testRender: async () => { renderTests++; return { state: "passed", summary: "Synthetic content passed." }; },
    testReddit: async () => { redditTests++; return reddit("ready", { at: "2026-09-18T12:34:56Z" }); },
  });
  await tick();
  const initial = h.text();
  assert.match(initial, /WEB BROWSER/); assert.match(initial, /○ NOT TESTED.*synthetic/);
  assert.match(initial, /External sites: not tested/);
  assert.match(initial, /REDDIT/); assert.match(initial, /✓ READY.*run \/reload/);
  assert.match(initial, /ADVANCED \[a\]/); assert.doesNotMatch(initial, /Collapsed|Distinct from the general bwrap renderer/);
  assert.doesNotMatch(initial, /Classic HTTP fetch|Manual remedy|Safe ready guidance|2026-09-18T/);
  assert.equal(renderTests, 0); assert.equal(redditTests, 0);
  h.view.handleInput("t"); await tick(); assert.equal(renderTests, 1); assert.match(h.text(), /✓ PASSED.*2026-09-18/);
  h.view.handleInput("e"); await tick(); assert.equal(redditTests, 1); assert.match(h.text(), /✓ READY.*run \/reload/);
  h.view.dispose();
});

test("refresh is parallel and independent, preserves proofs, and marks changed Reddit eligibility stale", async () => {
  let webCalls = 0, redditCalls = 0;
  const h = harness({
    inspectWeb: async () => { webCalls++; if (webCalls === 2) throw new Error("private-web-error"); return report(); },
    inspectReddit: async () => { redditCalls++; return reddit(redditCalls === 1 ? "ready" : "untested", { at: redditCalls === 1 ? "2026-09-17T00:00:00Z" : undefined }); },
    testRender: async () => ({ state: "passed", summary: "Explicit synthetic proof." }),
    testReddit: async () => reddit("ready", { at: "2026-09-18T00:00:00Z" }),
  });
  await tick(); h.view.handleInput("t"); await tick(); h.view.handleInput("e"); await tick();
  h.view.handleInput("r"); await tick();
  assert.equal(webCalls, 2); assert.equal(redditCalls, 2);
  assert.match(h.text(), /✓ PASSED/); assert.match(h.text(), /○ NOT TESTED · STALE VALIDATION.*Run Test Reddit/);
  h.view.handleInput("a");
  assert.match(h.text(), /Web browser inspection failed/); assert.doesNotMatch(h.text(), /private-web-error/);
  h.text(); h.view.handleInput("\x1b[F"); assert.match(h.text(), /Latest render detail[^]*Explicit synthetic proof/);
  h.view.dispose();
});

test("current Reddit observation supersedes historical failures after refresh", async () => {
  for (const [after, expected] of [["not_configured", /NOT CONFIGURED.*Configure the Reddit profile/], ["ready", /✓ READY.*current profile/]] as const) {
    let inspections = 0;
    const h = harness({
      inspectReddit: async () => reddit(inspections++ === 0 ? "untested" : after),
      testReddit: async () => reddit("access_denied"),
    });
    await tick(); h.view.handleInput("e"); await tick(); assert.match(h.text(), /ACCESS DENIED/);
    h.view.handleInput("r"); await tick(); assert.match(h.text(), expected); assert.doesNotMatch(h.text(), /ACCESS DENIED/);
    h.view.handleInput("a"); h.view.handleInput("\x1b[F");
    assert.match(h.text(), /Latest Reddit action[^]*access_denied/);
    h.view.dispose();
  }
});

test("cancelled Reddit action remains separate from current eligibility", async () => {
  const h = harness({ inspectReddit: async () => reddit("ready", { at: "2026-09-17T01:02:03Z" }), testReddit: async () => reddit("cancelled") });
  await tick(); h.view.handleInput("e"); await tick();
  assert.match(h.text(), /✓ READY/); assert.match(h.text(), /Latest test cancelled/); assert.match(h.text(), /Last validation: 2026-09-17 01:02Z/);
  h.view.dispose();
});

test("actions are single-flight; cancellation and disposal suppress late completion updates", async () => {
  let calls = 0, signal!: AbortSignal, finish!: (value: RenderProbeResult) => void;
  const h = harness({ testRender: (current) => { calls++; signal = current; return new Promise((resolve) => { finish = resolve; }); } });
  await tick(); h.view.handleInput("t"); h.view.handleInput("t"); h.view.handleInput("e");
  assert.equal(calls, 1); h.view.handleInput("c"); assert.equal(signal.aborted, true); assert.match(h.text(), /Cancelling/);
  finish({ state: "passed", summary: "late private success" }); await tick();
  assert.match(h.text(), /CANCELLED/); assert.doesNotMatch(h.text(), /late private success/);
  h.view.handleInput("t"); h.view.dispose(); assert.equal(signal.aborted, true);
  finish({ state: "passed", summary: "later success" }); await tick(); assert.doesNotMatch(h.text(), /later success/);
});

test("keyboard folds sections, selects actions, and scrolls/clamps across narrow resizes", async () => {
  let refreshes = 0, renders = 0;
  const h = harness({
    inspectWeb: async () => { refreshes++; return report(25); },
    testRender: async () => { renders++; return { state: "failed", summary: "Safe failure." }; },
  });
  await tick(); await tick();
  h.view.handleInput("\x1b[C"); h.view.handleInput("\r"); await tick(); assert.equal(renders, 1);
  h.view.handleInput("f"); h.view.handleInput("\r"); assert.doesNotMatch(h.text(), /External HTTP/); // browser folded
  h.view.handleInput("a"); assert.match(h.text(), /Manual remedy 0/);
  h.text(40, 15); h.view.handleInput("f"); assert.match(h.text(40, 15), /WEB BROWSER/);
  h.view.handleInput("f"); assert.match(h.text(40, 15), /REDDIT/);
  h.view.handleInput("f"); assert.match(h.text(40, 15), /ADVANCED \[a\]/); assert.match(h.text(40, 15), /Enter toggle/);
  h.view.handleInput("\x1b[F"); assert.match(h.text(40, 15), /Manual remedy 24/);
  h.view.handleInput("\x1b[5~"); h.view.handleInput("\x1b[H"); assert.match(h.text(40, 15), /WEB BROWSER/);
  h.view.handleInput("r"); await tick(); assert.equal(refreshes, 2);
  for (const width of [28, 40, 80]) for (const rows of [10, 15, 24]) {
    const lines = h.lines(width, rows);
    assert.ok(lines.length <= rows, `${width}x${rows}: ${lines.length}`);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}x${rows}`);
  }
  assert.match(h.text(28, 10), /Tab\/Shift\+Tab/);
  h.view.dispose();
});

test("missing local browser prerequisites are concise by default and detailed in Advanced", async () => {
  const missing: DiagnosticReport = { checks: [{ label: "System browser", state: "unavailable", summary: "No supported native executable found." }], remedies: ["Install a native browser."] };
  const h = harness({ inspectWeb: async () => missing }); await tick();
  assert.match(h.text(), /! NOT TESTED.*Local browser unavailable/); assert.doesNotMatch(h.text(), /No supported native/);
  h.view.handleInput("a"); assert.match(h.text(), /No supported native executable found/); h.view.dispose();
});

test("Reddit inspection failures do not hide browser diagnostics and disabled tests do not invoke an injected test", async () => {
  let tests = 0;
  const h = harness({
    inspectWeb: async () => report(),
    inspectReddit: async () => { throw new Error("private-config-content"); },
    testReddit: async () => { tests++; return reddit("untested", { enabled: false }); },
  });
  await tick(); assert.match(h.text(), /WEB BROWSER/); assert.match(h.text(), /○ UNKNOWN.*Refresh local/); assert.doesNotMatch(h.text(), /private-config-content|inspection failed/);
  h.view.handleInput("a"); assert.match(h.text(), /Reddit config inspection failed/); h.view.handleInput("a");
  h.view.handleInput("e"); await tick(); assert.equal(tests, 1); assert.match(h.text(), /DISABLED[^]*Enable web access/);
  h.view.dispose();
});
