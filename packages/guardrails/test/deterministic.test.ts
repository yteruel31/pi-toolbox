import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicies } from "../src/policies.js";
import { candidate, policy } from "./helpers.js";

const evaluate = (command: string, judgeEnabled = true) => evaluatePolicies(candidate({ args: { command } }), [], ["/project/.pi"], judgeEnabled).decision;

test("narrow built-in reads allow only when no higher restriction applies", () => {
  for (const command of ["ls", "ls --color=auto packages", "git status --short", "test -f package.json"]) {
    assert.equal(evaluate(command)?.action, "Allow", command);
    assert.equal(evaluate(command)?.policyIds[0], "builtin.safe-read", command);
  }
  const restricted = evaluatePolicies(candidate({ args: { command: "ls" } }), [policy({ action: "Ask" })], []);
  assert.equal(restricted.decision?.action, "Ask");
  const natural = evaluatePolicies(candidate({ args: { command: "ls" } }), [policy({ kind: "natural", description: "Review repository inspection" })], []);
  assert.equal(natural.decision, undefined);
  assert.equal(natural.natural.length, 1);
});

test("opaque shell remains unresolved instead of receiving unconditional Ask", () => {
  for (const command of ["touch file", "ls \"$(touch file)\"", "node script.js", "npm test", "git branch -D feature/example", "git remote set-url origin example", "git tag -d example", "test -X helper"]) {
    const on = evaluatePolicies(candidate({ args: { command } }), [], [], true);
    assert.equal(on.decision, undefined, command);
    assert.equal(evaluatePolicies(candidate({ args: { command } }), [], [], false).decision, undefined, command);
  }
});

test("detected denials dominate unknown segments and protected branch option order", () => {
  for (const command of [
    "node script.js; rm -rf /", "mkfs.ext4 /dev/sda", "dd if=/tmp/image of=/dev/sda",
    "git push origin main --force", "git push --force origin main", "git branch -D main",
    "touch /home/user/.ssh/id_rsa", "echo x > /home/user/.aws/credentials",
  ]) assert.equal(evaluate(command)?.action, "Deny", command);
});

test("read-only strings mentioning dangerous targets are not treated as mutations", () => {
  for (const command of ["printf '%s' /dev/sda", "grep main README.md", "cat README.md"]) {
    assert.equal(evaluate(command)?.action, "Allow", command);
  }
});

test("in-project writes require canonical non-sensitive non-protected targets", () => {
  assert.equal(evaluatePolicies(candidate({ tool: "write", args: { path: "src/new.ts", content: "x" } }), [], ["/project/.pi"]).decision?.action, "Allow");
  assert.equal(evaluatePolicies(candidate({ tool: "edit", args: { path: ".env" } }), [], []).decision?.action, "Deny");
  const root = mkdtempSync(join(tmpdir(), "guardrails-project-write-"));
  try {
    const project = join(root, "project"); mkdirSync(project); symlinkSync(join(root, "outside"), join(project, "alias"));
    const c = candidate({ cwd: project, project, tool: "write", args: { path: "alias/file", content: "x" } });
    assert.equal(evaluatePolicies(c, [], []).decision, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
