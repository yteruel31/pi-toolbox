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

test("detected denials dominate unknown or reviewable segments and protected branch option order", () => {
  for (const command of [
    "node script.js; rm -rf /", "rm -rf /; echo \"$(unknown)\"", "mkfs.ext4 /dev/sda", "dd if=/tmp/image of=/dev/sda",
    "cat .env; mkfs.ext4 /dev/sda", "cat /home/user/.ssh/id_rsa; dd if=/tmp/image of=/dev/sda",
    "git push origin main --force", "git push --force origin main", "git push origin +HEAD:main",
    "git push --repo=origin --force HEAD:main", "git -c core.abbrev=8 push --force origin main",
    "git push origin --delete main", "git branch -D main", "git branch -d main",
    "touch /home/user/.ssh/id_rsa", "rm -r ~/.ssh", "sed -i -e 's/a/b/' .env", "mv .env public.txt",
    "echo x > /home/user/.aws/credentials",
  ]) assert.equal(evaluate(command)?.action, "Deny", command);
});

test("sensitive input redirections and reads require review", () => {
  for (const command of ["cat < .env", "cat < ~/.ssh/id_rsa", "cat .env"]) {
    assert.equal(evaluate(command)?.action, "Ask", command);
    assert.equal(evaluate(command, false)?.action, "Ask", command);
  }
});

test("unknown read and Git options never establish safety", () => {
  for (const command of [
    "ls --definitely-invalid", "git diff --outpu=.pi/settings.json", "git diff --ext-dif",
    "git --config-env=core.fsmonitor=GUARDRAILS_TEST_HELPER status", "git -p log", "git --paginate log",
  ]) assert.equal(evaluate(command), undefined, command);
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
    const escaped = candidate({ cwd: project, project, tool: "write", args: { path: "alias/../outside.txt", content: "x" } });
    assert.equal(evaluatePolicies(escaped, [], []).decision, undefined);
    symlinkSync("loop", join(project, "loop"));
    assert.throws(() => evaluatePolicies(candidate({ cwd: project, project, args: { command: "cat loop" } }), [], []));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
