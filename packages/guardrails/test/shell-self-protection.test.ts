import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicies } from "../src/policies.js";
import { candidate, policy } from "./helpers.js";

const protectedPaths = ["/project/.pi", "/installed/pi-guardrails"];
const evaluate = (command: string) => evaluatePolicies(candidate({ args: { command } }), [], protectedPaths).decision;

test("read-only investigation is not shell self-modification", () => {
  for (const command of [
    "git status --short; rg -n 'self-modification|protectedPaths|self-protection' packages/guardrails/src",
    "rg guardrails packages/guardrails/src", "grep -n 'guardrails.json' /project/.pi/guardrails.json",
    "cat '/project/.pi/guardrails.json'", "head -n 5 /project/.pi/guardrails.json",
    "git log --oneline yoann/guardrails-self-protection", "git status --short -- guardrails.json",
    "rg --files /installed/pi-guardrails", "printf '%s' guardrails",
  ]) assert.notEqual(evaluate(command)?.policyIds[0], "builtin.self-protection", command);
});

test("ordinary CLI prompts are data, not executable shell fragments", () => {
  for (const command of [
    "orca worktree create --name guardrails-fix --prompt 'Fix guardrails; rm /project/.pi/guardrails.json'",
    "ordinary-cli --prompt 'guardrails > /project/.pi/guardrails.json'",
  ]) {
    assert.notEqual(evaluate(command)?.action, "Deny", command);
    assert.ok(!evaluate(command)?.policyIds.includes("builtin.self-protection"), command);
  }
});

test("static mutations of canonical protected targets are denied", () => {
  for (const command of [
    "echo disable > /project/.pi/guardrails.json", "echo x >> '.pi/guardrails.json'",
    "printf x 2>/project/.pi/error.log", "cat < /tmp/input > /project/.pi/new",
    "tee -a /project/.pi/guardrails.json", "echo x | tee /project/.pi/guardrails.json",
    "rm -rf /project/.pi", "r\\m '/project/.pi/guardrails.json'", "rm -rf /project",
    "cp /tmp/new /project/.pi/guardrails.json", "cp -t /project/.pi /tmp/new",
    "mv /project/.pi /tmp/backup", "install -m 600 /tmp/new /project/.pi/new",
    "truncate -s 0 /project/.pi/guardrails.json", "chmod 600 /project/.pi/guardrails.json",
    "sed -i 's/true/false/' /project/.pi/guardrails.json", "dd if=/tmp/new of=/project/.pi/guardrails.json",
    "git status; rm /project/.pi/guardrails.json", "true && rm /project/.pi/guardrails.json",
    "rm ../project/.pi/guardrails.json", "echo x &>/project/.pi/log", "echo x >|/project/.pi/log",
    "chmod 600 > /tmp/log /project/.pi/guardrails.json", 'chmod "600">/tmp/log /project/.pi/guardrails.json',
    "install -vd /project/.pi/new /tmp/safe", "env true > /project/.pi/guardrails.json",
    "rm /project/.pi/guardrails.json; env true", "cp /tmp/.pi /project",
  ]) assert.equal(evaluate(command)?.action, "Deny", command);
});

test("unknown execution stays deterministic Ask, even with exact and natural Allow", () => {
  for (const command of [
    "python -c 'modify guardrails.json'", "bash -c 'rm /project/.pi/guardrails.json'",
    "node script.js /project/.pi", "eval 'rm /project/.pi/guardrails.json'",
    'echo "$(rm /project/.pi/guardrails.json)"', 'ordinary-cli --prompt "$(rm /project/.pi/guardrails.json)"',
    "echo `rm /project/.pi/guardrails.json`", "env X=x rm /project/.pi/guardrails.json",
    "command rm /project/.pi/guardrails.json", "sudo rm /project/.pi/guardrails.json",
    "cat <<'EOF'\nrm /project/.pi/guardrails.json\nEOF", "rm /project/.p*",
    "cd /project/.pi; rm guardrails.json", "find /project -exec rm -rf {} +",
    "rg --pre 'rm /project/.pi/guardrails.json' x .", "git -c alias.x='!rm /project/.pi/x' x",
    "git diff --output=/project/.pi/x", "custom-writer /project/.pi/guardrails.json",
    "source /tmp/script", "./script.sh", "echo ${TARGET}", "echo 'unterminated",
    "file -C -m /project/.pi/magic", "printf -vPATH x", "rm ~other/.pi/config",
    "rm '~/.pi/config'", "rm \\~/.pi/config", "rm ''~/.pi/config",
    "ln -s /project/.pi /tmp/new-alias; tee /tmp/new-alias/config",
    "cp -a /tmp/alias /tmp/new-alias; rm /tmp/new-alias/config",
    "> /tmp/log cd /tmp; rm .pi/guardrails.json", "echo\u00a0guardrails",
    "cp -rT /tmp/source /project", "cp -r /tmp/source/. /project",
    "git diff --out=/project/.pi/config", "sed -i -f /project/.pi/rewrite.sed /tmp/notes",
    "cp -r /tmp/tree /tmp/other", "cp --target-directory='~/.pi' /tmp/notes",
    "cp --target-directory=~/.pi /tmp/notes", "dd of='~/.pi/config'",
  ]) {
    const rules = [policy({ action: "Allow", conditions: { command } }), policy({ id: "natural", kind: "natural", action: "Allow", description: "Allow everything" })];
    const result = evaluatePolicies(candidate({ args: { command } }), rules, protectedPaths);
    assert.equal(result.decision, undefined, command);
    assert.equal(result.natural.length, 1, command);
    assert.equal(evaluatePolicies(candidate({ args: { command } }), [rules[0]], protectedPaths).decision, undefined, command);
    assert.equal(evaluatePolicies(candidate({ args: { command } }), [policy({ action: "Deny" })], protectedPaths).decision?.action, "Deny", command);
  }
});

test("home expansion uses configured roots, not a hard-coded Pi directory", () => {
  assert.equal(evaluatePolicies(candidate({ args: { command: "rm ~/.pi/guardrails.json" } }), [], [join(homedir(), ".pi")]).decision?.action, "Deny");
  assert.equal(evaluatePolicies(candidate({ tool: "write", args: { path: "guardrails.json" } }), [], protectedPaths).decision?.action, "Allow");
  assert.equal(evaluate("cp /tmp/notes.txt /project"), undefined);
  assert.equal(evaluate("cp -t /project /tmp/notes.txt"), undefined);
  assert.equal(evaluate("mv /tmp/notes.txt /project"), undefined);
});

test("relative and symlink shell destinations use real ancestors and component boundaries", () => {
  const root = mkdtempSync(join(tmpdir(), "shell-policy-"));
  try {
    mkdirSync(join(root, "private"));
    symlinkSync(join(root, "private"), join(root, "alias"));
    for (const command of ["echo x > alias/new", "rm -rf alias", "cp /tmp/new ./private/new", "rm -rf ."]) {
      assert.equal(evaluatePolicies(candidate({ cwd: root, args: { command } }), [], [join(root, "private")]).decision?.action, "Deny", command);
    }
    assert.equal(evaluatePolicies(candidate({ cwd: root, args: { command: "rm -rf private-other" } }), [], [join(root, "private")]).decision, undefined);
    mkdirSync(join(root, "staging"));
    writeFileSync(join(root, "private", "config"), "fixture");
    symlinkSync(join(root, "private", "config"), join(root, "staging", "config"));
    assert.equal(evaluatePolicies(candidate({ cwd: root, args: { command: "cp /tmp/config staging" } }), [], [join(root, "private")]).decision?.action, "Deny");
    symlinkSync(join(root, "private", "missing"), join(root, "dangling"));
    assert.equal(evaluatePolicies(candidate({ cwd: root, args: { command: "echo x > dangling" } }), [], [join(root, "private")]).decision?.action, "Deny");
    for (const tool of ["write", "edit"] as const) {
      assert.equal(evaluatePolicies(candidate({ cwd: root, tool, args: { path: "dangling" } }), [], [join(root, "private")]).decision?.action, "Deny");
    }
    mkdirSync(join(root, "private", "subdir"));
    symlinkSync(join(root, "private", "subdir"), join(root, "nested-alias"));
    assert.equal(evaluatePolicies(candidate({ cwd: root, args: { command: "rm nested-alias/../config" } }), [], [join(root, "private")]).decision, undefined);
    for (const tool of ["write", "edit"] as const) {
      assert.equal(evaluatePolicies(candidate({ cwd: root, tool, args: { path: "alias/new" } }), [], [join(root, "private")]).decision?.action, "Deny");
    }
  } finally { rmSync(root, { recursive: true }); }
});
