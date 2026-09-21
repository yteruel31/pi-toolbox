import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, canonicalShellPath, complexShell, evaluatePolicies } from "../src/policies.js";
import { presets } from "../src/config.js";
import { candidate, policy } from "./helpers.js";

test("Deny > Ask > Allow, independent of order; disabled and actor scope are honored", () => {
  for (const rules of [[policy({ action: "Allow" }), policy({ id: "deny", action: "Deny" })], [policy({ id: "deny", action: "Deny" }), policy({ action: "Allow" })]]) {
    assert.equal(evaluatePolicies(candidate(), rules, []).decision?.action, "Deny");
  }
  assert.equal(evaluatePolicies(candidate(), [policy({ action: "Allow" }), policy({ id: "ask" })], []).decision?.action, "Ask");
  assert.equal(evaluatePolicies(candidate(), [policy({ enabled: false })], []).decision?.action, "Allow");
  assert.equal(evaluatePolicies(candidate({ actor: { kind: "subagent", runId: "1" } }), [policy({ scope: "main" })], []).decision?.policyIds[0], "builtin.safe-read");
  assert.equal(evaluatePolicies(candidate({ actor: { kind: "subagent", runId: "1" }, tool: "write", args: { path: "src/a.ts", content: "secret body" } }), [policy({ scope: "subagent", action: "Allow", conditions: { pathPrefix: "/project/src" } })], []).decision?.action, "Allow");
});
test("explicit exact simple shell allowances never apply to complex commands", () => {
  const allow = (command: string) => evaluatePolicies(candidate({ args: { command } }), [policy({ action: "Allow", conditions: { command } })], []).decision;
  assert.equal(allow("git status")?.action, "Allow");
  for (const command of ["git status; rm -rf /tmp/x", "echo $(rm -rf x)", "bash -c 'git status'", "cat <<EOF\nsecret\nEOF", "env X=x git status", "git status | cat", "echo `whoami`", "python3 -c pass", "git status && git diff", "g'it' status", "rm /tmp/*"]) {
    assert.equal(complexShell(command), true, command); assert.notEqual(allow(command)?.policyIds[0], "test", command);
  }
});
test("presets scan the whole command, including quoted/escaped and chained operations", () => {
  for (const command of ["git reset --hard", "git -C /tmp/x push --force", "git status; git clean -fd", "g'it' reset --hard", "git stash clear", "r\\m -rf /tmp/x", "find . -delete", "sudo apt install x", "echo x > config", "kubectl get pods --context prod", "cat .env", "cat ~/.ssh/id_rsa", "cat /tmp/secret.pem", "printenv"]) {
    assert.equal(evaluatePolicies(candidate({ args: { command } }), presets, []).decision?.action, "Ask", command);
  }
});
test("path matching uses native normalization, component boundaries and real ancestors", () => {
  const root = mkdtempSync(join(tmpdir(), "guardrails-path-"));
  try {
    mkdirSync(join(root, "private"));
    writeFileSync(join(root, "private", ".env"), "DO_NOT_READ=hidden");
    symlinkSync(join(root, "private"), join(root, "alias"));
    assert.equal(canonicalPath("@alias/new.txt", root), join(root, "private/new.txt"));
    assert.equal(canonicalPath("alias/../.pi/settings.json", root), join(root, ".pi/settings.json"));
    assert.equal(canonicalShellPath("alias/../.pi/settings.json", root), join(root, ".pi/settings.json"));
    symlinkSync(join(root, "private", "child"), join(root, "escape"));
    assert.equal(canonicalShellPath("escape/../.pi/settings.json", root), join(root, "private/.pi/settings.json"));
    assert.equal(canonicalPath("name\u2007with-space", root), join(root, "name with-space"));
    assert.equal(canonicalPath(new URL(`file://${root}/alias/../file`).href, root), join(root, "file"));
    const c = candidate({ cwd: root, tool: "read", args: { path: "alias/.env" } });
    assert.equal(evaluatePolicies(c, presets, []).decision?.action, "Ask");
    assert.equal(evaluatePolicies(candidate({ tool: "read", args: { path: "/project/secretish/file" } }), [policy({ conditions: { pathPrefix: "/project/secret" } })], []).decision?.action, "Allow");
  } finally { rmSync(root, { recursive: true }); }
});
test("path traversal preserves self-protection and explicit Deny precedence", () => {
  const protectedWrite = candidate({ tool: "write", args: { path: "/project/src/../.pi/config", content: "x" } });
  assert.equal(evaluatePolicies(protectedWrite, [policy({ action: "Allow" })], ["/project/.pi"]).decision?.action, "Deny");
  const denied = candidate({ tool: "write", args: { path: "/project/src/../a", content: "x" } });
  assert.equal(evaluatePolicies(denied, [policy({ action: "Deny", tools: ["write"] })], []).decision?.action, "Deny");
});

test("policy self-write cannot be granted by a policy or natural assessment", () => {
  const rules = [policy({ action: "Allow" })];
  for (const tool of ["write", "edit"] as const) assert.equal(evaluatePolicies(candidate({ tool, args: { path: "/project/.pi/guardrails.json" } }), rules, ["/project/.pi"]).decision?.action, "Deny");
  for (const command of ["echo disable > /project/.pi/guardrails.json", "rm -rf /project/.pi"]) assert.equal(evaluatePolicies(candidate({ args: { command } }), rules, ["/project/.pi"]).decision?.action, "Deny");
  assert.equal(evaluatePolicies(candidate({ args: { command: "python -c 'modify guardrails.json'" } }), rules, ["/project/.pi"]).decision, undefined);
});
test("natural restrictions must be assessed before a structured Allow", () => {
  const result = evaluatePolicies(candidate(), [policy({ action: "Allow", conditions: { command: "git status" } }), policy({ id: "natural", kind: "natural", description: "Ask before reading this production checkout" })], []);
  assert.equal(result.decision, undefined); assert.equal(result.natural.length, 1);
});
