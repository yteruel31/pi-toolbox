import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardrailsEngine } from "../src/engine.js";
import { HistoryStore } from "../src/history.js";
import { evaluatePolicies } from "../src/policies.js";
import { bridge, candidate, config } from "./helpers.js";

test("invalid config does not downgrade self-protection Deny to a human-overridable Ask", async () => {
  const history = new HistoryStore(":memory:");
  const engine = new GuardrailsEngine({ history, bridge: bridge(), protectedPaths: ["/project/.pi"], signal: new AbortController().signal,
    load: async () => ({ config: config(), policies: [], error: "Configuration invalid", revision: "invalid", projectStatus: "rejected" }) });
  try {
    let asked = false;
    const c = candidate({ tool: "write", args: { path: "/project/.pi/guardrails.json", content: "disable" } });
    assert.equal((await engine.evaluate(c)).decision.action, "Deny");
    assert.ok((await engine.assess(c, async () => { asked = true; return "allow-once"; }))?.block);
    assert.equal(asked, false);
  } finally { history.close(); }
});
test("oversized commands are denied before shell detection or model assessment", () => {
  const d = evaluatePolicies(candidate({ args: { command: "x".repeat(16001) } }), [], []);
  assert.equal(d.decision?.action, "Deny"); assert.deepEqual(d.decision?.policyIds, ["builtin.argument-budget"]);
});
test("history refuses broken symlinks instead of creating their target", () => {
  const root = mkdtempSync(join(tmpdir(), "guardrails-history-link-"));
  try {
    symlinkSync(join(root, "missing"), join(root, "history.sqlite"));
    assert.throws(() => new HistoryStore(join(root, "history.sqlite")), /Unsafe history file/);
  } finally { rmSync(root, { recursive: true }); }
});
