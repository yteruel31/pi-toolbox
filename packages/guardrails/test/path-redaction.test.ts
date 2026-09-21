import assert from "node:assert/strict";
import { test } from "node:test";
import { candidateView, sanitize, sanitizePath } from "../src/sanitize.js";
import { HistoryStore, relevantHistory } from "../src/history.js";
import { GuardrailsEngine } from "../src/engine.js";
import { judge } from "../src/judge.js";
import { evaluatePolicies } from "../src/policies.js";
import { bridge, candidate, config, entry } from "./helpers.js";

const cwd = "/home/developer/dev/worktrees/pi-toolbox/long-running-feature-branch";
const path = `${cwd}/packages/guardrails/test/panel.test.ts`;

test("filesystem separators do not turn an ordinary long worktree path into a credential", () => {
  assert.match(sanitize(cwd), /omitted/, "generic text retains its opaque-value protection");
  assert.equal(sanitizePath(cwd), cwd);
  assert.equal(sanitizePath(path), path);
  const view = candidateView(candidate({ tool: "read", cwd, project: cwd, args: { path } }), path, "read");
  assert.equal(view.cwd, cwd); assert.equal(view.target, path);
  assert.deepEqual(view.args, { path, offset: undefined, limit: undefined });
  assert.equal(view.assessmentIncomplete, false);
});

test("known credentials, opaque components, terminal controls and length limits remain protected", () => {
  const credential = "ghp_" + "A".repeat(40);
  assert.doesNotMatch(sanitizePath(`${cwd}/${credential}/file`), new RegExp(credential));
  assert.match(sanitizePath(`${cwd}/${"A".repeat(64)}/file`), /long value omitted/);
  assert.doesNotMatch(sanitizePath(`${cwd}/password=private-value/file`), /private-value/);
  assert.doesNotMatch(sanitizePath(`${cwd}/\x1b[31mred\u202e`), /\x1b|\u202e/);
  assert.equal(sanitizePath(path, 20).length, 20);
  // The path-aware mode isn't used for arbitrary payload strings containing base64 separators.
  assert.match(sanitize("A".repeat(24) + "/" + "B".repeat(24)), /long value omitted/);
});

test("redacted cwd or target is explicitly incomplete even with a clean relative read argument", async () => {
  for (const [root, target] of [[`${cwd}/${"A".repeat(64)}`, path], [cwd, `${cwd}/${"A".repeat(64)}`]]) {
    const c = candidate({ tool: "read", cwd: root, project: root, args: { path: "README.md" } });
    assert.equal(candidateView(c, target, "read").assessmentIncomplete, true);
    assert.equal((await judge(bridge(), config(), c, [], [], target, "read")).action, "Ask");
  }
});

test("ordinary main and worker reads are assessable without a false redaction prompt", async () => {
  const history = new HistoryStore(":memory:");
  const settings = config();
  const engine = new GuardrailsEngine({ history, bridge: bridge(), protectedPaths: [], signal: new AbortController().signal,
    load: async () => ({ config: settings, policies: settings.policies, revision: "test", projectStatus: "test" }),
  });
  try {
    for (const actor of [{ kind: "main" } as const, { kind: "subagent", runId: "worker", childSessionId: "child" } as const]) {
      const c = candidate({ tool: "read", actor, cwd, project: cwd, args: { path } });
      let approvals = 0;
      assert.equal(await engine.assess(c, async () => { approvals++; return "deny"; }), undefined);
      assert.equal(approvals, 0);
      engine.result(c, false);
    }
    for (const e of history.list()) {
      assert.equal(e.project, cwd); assert.equal(e.cwd, cwd); assert.equal(e.target, path);
      assert.equal(e.summary, `read ${path}`); assert.equal(e.execution, "reported-success");
    }
  } finally { history.close(); }
});

test("history round trips preserve ordinary filesystem targets and project-specific matching", () => {
  const history = new HistoryStore(":memory:");
  try {
    const e = entry({ tool: "read", project: cwd, cwd, target: path, summary: `read ${path}` });
    history.put(e);
    assert.equal(history.list()[0].summary, `read ${path}`);
    const c = candidate({ tool: "read", project: cwd, cwd, args: { path } });
    assert.equal(relevantHistory(history.list(), c, path, "read", []).length, 1);
  } finally { history.close(); }
});

test("path readability grants no blanket permission and secret-file restrictions still win", () => {
  const c = candidate({ tool: "read", cwd, project: cwd, args: { path: `${cwd}/.env` } });
  assert.equal(evaluatePolicies(c, config().policies, []).decision?.action, "Ask");
  const ordinary = candidate({ tool: "read", cwd, project: cwd, args: { path } });
  assert.equal(evaluatePolicies(ordinary, [], []).decision?.action, "Allow", "ordinary non-sensitive local reads are allowed");
});
