import { test } from "node:test";
import assert from "node:assert/strict";
import { GuardrailsEngine } from "../src/engine.js";
import { HistoryStore } from "../src/history.js";
import { bridge, candidate, config, policy } from "./helpers.js";
import type { Config } from "../src/config.js";

function fixture(conf: Config = config(), completion = bridge()) {
  const history = new HistoryStore(":memory:");
  const controller = new AbortController();
  const engine = new GuardrailsEngine({ history, bridge: completion, load: async () => ({ config: conf, policies: conf.policies, revision: "test", projectStatus: "none" }), protectedPaths: ["/project/.pi"], signal: controller.signal });
  return { engine, history, controller };
}
test("hard policy verdicts never invoke a completion; one entry evolves through approval and result", async () => {
  const b = bridge(); b.complete = async () => { throw Error("must not run"); };
  const { engine, history } = fixture(config(), b);
  try {
    const c = candidate({ args: { command: "git reset --hard" } });
    assert.equal(await engine.assess(c, async (e) => { assert.equal(e.state, "review"); assert.equal(history.list().length, 1); return "allow-once"; }), undefined);
    assert.equal(history.list()[0].state, "allowed"); assert.equal(history.list()[0].execution, "not-observed");
    engine.result(c, false);
    assert.equal(history.list().length, 1); assert.equal(history.list()[0].execution, "reported-success"); assert.equal(history.list()[0].choice, "allow-once");
  } finally { history.close(); }
});
test("worker Ask is blocked without any approval popup; main headless Ask is also blocked", async () => {
  const { engine, history } = fixture();
  try {
    let asks = 0;
    const worker = candidate({ actor: { kind: "subagent", runId: "r", profile: "worker" }, args: { command: "git reset --hard" } });
    assert.ok((await engine.assess(worker, async () => { asks++; return "allow-once"; }))?.block);
    assert.equal(asks, 0); assert.match(history.list()[0].reason, /safe alternative/);
    assert.ok((await engine.assess(candidate({ args: { command: "git reset --hard" } })))?.block);
    assert.equal(history.list().length, 2);
  } finally { history.close(); }
});
test("Deny and stop terminates; hard Deny never asks; past approvals do not grant another call", async () => {
  const { engine, history } = fixture();
  try {
    const args = { command: "git reset --hard" };
    const first = await engine.assess(candidate({ args }), async () => "deny-stop"); assert.equal(first?.terminate, true);
    await engine.assess(candidate({ args }), async () => "allow-once");
    assert.ok((await engine.assess(candidate({ args })))?.block);
    let asks = 0;
    assert.ok((await engine.assess(candidate({ tool: "write", args: { path: "/project/.pi/guardrails.json", content: "{}" } }), async () => { asks++; return "allow-once"; }))?.block);
    assert.equal(asks, 0);
  } finally { history.close(); }
});
test("worker allowances may be more permissive while main restrictions remain active", async () => {
  const { engine, history } = fixture(config({ policies: [policy({ scope: "main" }), policy({ id: "worker", scope: "subagent", action: "Allow", conditions: { command: "git status" } })] }));
  try {
    assert.ok((await engine.assess(candidate()))?.block);
    assert.equal(await engine.assess(candidate({ actor: { kind: "subagent", runId: "worker" } })), undefined);
  } finally { history.close(); }
});
test("dry-run evaluation never records a call and disabled protection never assesses", async () => {
  const { engine, history } = fixture();
  try { await engine.evaluate(candidate()); assert.equal(history.list().length, 0); } finally { history.close(); }
  const disabled = fixture(config({ enabled: false }));
  try { assert.equal(await disabled.engine.assess(candidate({ args: { command: "rm -rf /" } })), undefined); assert.equal(disabled.history.list().length, 0); } finally { disabled.history.close(); }
});
test("parent/session cancellation blocks pending assessments and later calls", async () => {
  const b = bridge(); b.complete = async () => new Promise(() => {});
  const { engine, history, controller } = fixture(config({ policies: [] }), b);
  try {
    const pending = engine.assess(candidate({ args: { command: "opaque-command" } }));
    await new Promise((r) => setTimeout(r, 5)); controller.abort();
    assert.ok((await pending)?.block); assert.ok((await engine.assess(candidate()))?.block);
  } finally { history.close(); }
});
test("storage failure cannot allow the tool", async () => {
  const { engine, history } = fixture(); history.close();
  assert.ok((await engine.assess(candidate()))?.block);
});
