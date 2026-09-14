import { test } from "node:test";
import assert from "node:assert/strict";
import { GuardrailsEngine } from "../src/engine.js";
import { HistoryStore } from "../src/history.js";
import type { ConfigSnapshot } from "../src/config.js";
import type { Tool, Actor } from "../src/types.js";
import { bridge, candidate, config, policy } from "./helpers.js";

const tools: Tool[] = ["bash", "read", "write", "edit", "mcp", "web-access"];
const actors: Actor[] = [{ kind: "main" }, { kind: "subagent", runId: "worker" }];
const args = (tool: Tool) => tool === "bash" ? { command: "git status" } : tool === "mcp" || tool === "web-access" ? { operation: "inspect", arguments: {} } : { path: "README.md" };
function fixture() {
  let snapshot: ConfigSnapshot = { config: config({ policies: [], judgeEnabled: false }), policies: [], revision: "test", projectStatus: "none" };
  const history = new HistoryStore(":memory:");
  let resolves = 0, completions = 0, prompts = 0;
  const fake = bridge();
  const engine = new GuardrailsEngine({ load: async () => snapshot, history, protectedPaths: ["/protected"], signal: new AbortController().signal,
    bridge: { resolve: (c) => { resolves++; return fake.resolve(c); }, complete: async (...a) => { completions++; return fake.complete(...a); } } });
  return { engine, history, snapshot, setSnapshot: (s: ConfigSnapshot) => { snapshot = s; }, counts: () => [resolves, completions, prompts], approval: async () => { prompts++; return "allow-once" as const; } };
}
for (const tool of tools) for (const actor of actors.filter((actor) => actor.kind === "main" || !["mcp", "web-access"].includes(tool))) {
  test(`${tool}/${actor.kind}: disabled coverage bypasses rules, history and judge; enabled coverage enforces`, async () => {
    const f = fixture();
    try {
      f.snapshot.policies = [policy({ tools: [tool], action: "Deny" })];
      f.snapshot.config.coverage[tool] = false;
      const c = candidate({ tool, args: args(tool), actor });
      assert.equal(await f.engine.assess(c, f.approval), undefined);
      assert.equal((await f.engine.evaluate(c)).enabled, false);
      assert.equal(f.history.list().length, 0); assert.deepEqual(f.counts(), [0, 0, 0]);
      f.snapshot.config.coverage[tool] = true;
      assert.ok((await f.engine.assess(c, f.approval))?.block);
      assert.equal(f.history.list()[0].action, "Deny");
      f.history.close(); f.snapshot.config.coverage[tool] = false;
      assert.equal(await f.engine.assess(c, f.approval), undefined, "closed history must not affect bypass");
    } finally { f.history.close(); }
  });
}
for (const actor of actors) {
  test(`rule-only ${actor.kind}: no match and natural-only allow distinctly; re-enable restores judge`, async () => {
    const f = fixture();
    try {
      for (const policies of [[], [policy({ kind: "natural", description: "Deny all calls", action: "Deny" })]]) {
        f.snapshot.policies = policies;
        const c = candidate({ actor });
        assert.equal(await f.engine.assess(c, f.approval), undefined);
        const recorded = f.history.list().find((e) => e.callId === c.callId)!;
        assert.equal(recorded.origin, "rule-only-no-match"); assert.equal(recorded.model, undefined);
        assert.deepEqual(recorded.policyIds, []); assert.equal(recorded.choice, undefined);
      }
      assert.deepEqual(f.counts(), [0, 0, 0]);
      f.snapshot.config.judgeEnabled = true;
      await f.engine.assess(candidate({ actor }), f.approval);
      assert.deepEqual(f.counts(), [1, 1, 0]);
    } finally { f.history.close(); }
  });
  test(`rule-only ${actor.kind}: Deny > Ask > Allow, including complex shell and inactive natural restrictions`, async () => {
    const f = fixture();
    const c = candidate({ actor, args: { command: "echo one && echo two" } });
    try {
      f.snapshot.policies = [policy({ id: "allow", action: "Allow" }), policy({ id: "natural", kind: "natural", description: "Never allow", action: "Deny" })];
      assert.equal((await f.engine.evaluate(c)).decision.origin, "policy");
      assert.equal(await f.engine.assess(c, f.approval), undefined);
      f.snapshot.policies.push(policy({ id: "ask", action: "Ask" }));
      const ask = candidate({ ...c, callId: "ask" });
      assert.equal((await f.engine.evaluate(ask)).decision.action, "Ask");
      assert.equal(!!(await f.engine.assess(ask, f.approval))?.block, actor.kind === "subagent");
      assert.deepEqual(f.counts(), [0, 0, actor.kind === "main" ? 1 : 0]);
      f.snapshot.policies.unshift(policy({ id: "deny", action: "Deny" }));
      assert.equal((await f.engine.evaluate(c)).decision.action, "Deny");
    } finally { f.history.close(); }
  });
  test(`rule-only ${actor.kind}: invalid config and storage failure cannot become no-match allows`, async () => {
    const f = fixture();
    try {
      f.snapshot.error = "Invalid configuration";
      f.snapshot.config.enabled = false;
      f.snapshot.policies = [policy({ action: "Allow" })];
      const c = candidate({ actor });
      assert.equal((await f.engine.evaluate(c)).decision.origin, "error");
      assert.ok((await f.engine.assess(c))?.block);
      f.snapshot.config.errorBehavior = "deny";
      assert.ok((await f.engine.assess(candidate({ actor }), f.approval))?.block);
      assert.deepEqual(f.counts(), [0, 0, 0]);
      delete f.snapshot.error; f.snapshot.config.enabled = true; f.snapshot.policies = [];
      const broken = candidate({ actor, args: new Proxy({}, { get() { throw Error("resolver failed"); } }) });
      assert.ok((await f.engine.assess(broken, f.approval))?.block, "evaluator exceptions stay closed");
      f.history.close(); assert.ok((await f.engine.assess(candidate({ actor }), f.approval))?.block);
    } finally { f.history.close(); }
  });
}
test("rule-only retains builtin argument and self protections; global Off skips even argument inspection", async () => {
  const f = fixture();
  try {
    assert.equal((await f.engine.evaluate(candidate({ tool: "write", args: { path: "/protected/config" } }))).decision.action, "Deny");
    assert.equal((await f.engine.evaluate(candidate({ args: { command: "x".repeat(16001) } }))).decision.action, "Deny");
    f.snapshot.config.enabled = false;
    const poisoned = candidate({ args: new Proxy({}, { get() { throw Error("must not inspect"); } }) });
    assert.equal(await f.engine.assess(poisoned, f.approval), undefined);
    assert.equal((await f.engine.evaluate(poisoned)).enabled, false);
    assert.deepEqual(f.counts(), [0, 0, 0]);
  } finally { f.history.close(); }
});
