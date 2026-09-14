import { test } from "node:test";
import assert from "node:assert/strict";
import { GuardrailsEngine } from "../src/engine.js";
import { HistoryStore } from "../src/history.js";
import { bridge, candidate, config, policy } from "./helpers.js";

for (const judgeEnabled of [true, false]) for (const error of [undefined, "Invalid configuration"]) {
  test(`shell hard decisions precede model/exact Allow and preserve approval boundaries (judge: ${judgeEnabled}, config error: ${!!error})`, async () => {
    const history = new HistoryStore(":memory:");
    const completion = bridge();
    let completions = 0, approvals = 0;
    completion.complete = async () => { completions++; throw Error("must not judge"); };
    const commands = ["custom-writer /project/.pi/config", "echo x > /project/.pi/config"];
    const policies = commands.map((command, i) => policy({ id: `allow-${i}`, action: "Allow", conditions: { command } }));
    const cfg = config({ policies, judgeEnabled });
    const engine = new GuardrailsEngine({ history, bridge: completion, protectedPaths: ["/project/.pi"], signal: new AbortController().signal,
      load: async () => ({ config: cfg, policies, error, revision: "test", projectStatus: "none" }) });
    const approve = async () => { approvals++; return "allow-once" as const; };
    try {
      for (const [i, command] of commands.entries()) {
        const main = candidate({ args: { command } });
        assert.equal((await engine.evaluate(main)).decision.action, i === 0 ? "Ask" : "Deny");
        assert.equal(!!(await engine.assess(main, approve))?.block, i !== 0);
        assert.ok((await engine.assess(candidate({ args: { command }, actor: { kind: "subagent", runId: "worker" } }), approve))?.block);
      }
      assert.equal(approvals, 1);
      assert.equal(completions, 0);
      assert.match(history.list().find((entry) => entry.actor.kind === "subagent" && entry.action === "Ask")!.reason, /Worker Ask is blocked/);
    } finally { history.close(); }
  });
}

test("disabled guardrails bypass shell protection without history or prompts", async () => {
  const history = new HistoryStore(":memory:");
  const cfg = config({ enabled: false });
  const engine = new GuardrailsEngine({ history, bridge: bridge(), protectedPaths: ["/project/.pi"], signal: new AbortController().signal,
    load: async () => ({ config: cfg, policies: cfg.policies, revision: "test", projectStatus: "none" }) });
  try {
    for (const command of ["echo x > /project/.pi/config", "eval hidden-script"]) {
      for (const actor of [{ kind: "main" }, { kind: "subagent", runId: "worker" }] as const) {
        const c = candidate({ args: { command }, actor });
        assert.equal((await engine.evaluate(c)).enabled, false);
        assert.equal(await engine.assess(c, async () => { assert.fail("must not prompt"); }), undefined);
      }
    }
    assert.equal(history.list().length, 0);
  } finally { history.close(); }
});
