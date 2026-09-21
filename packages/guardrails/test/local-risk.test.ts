import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluatePolicies } from "../src/policies.js";
import { candidate, policy } from "./helpers.js";

const run = (cwd: string, command: string, judgeEnabled = true) => evaluatePolicies(candidate({ cwd, project: cwd, args: { command } }), [], [], judgeEnabled).decision;

test("ordinary native reads allow while sensitive reads remain reviewed", () => {
  assert.equal(evaluatePolicies(candidate({ tool: "read", args: { path: "README.md" } }), [], []).decision?.action, "Allow");
  assert.equal(evaluatePolicies(candidate({ tool: "read", args: { path: ".env" } }), [], []).decision?.action, "Ask");
  assert.equal(evaluatePolicies(candidate({ tool: "read", args: { path: "README.md" } }), [policy({ tools: ["read"], action: "Ask" })], []).decision?.action, "Ask");
});

test("deleting pristine tracked files is recoverable; modified and untracked work asks", () => {
  const root = mkdtempSync(join(tmpdir(), "guardrails-local-risk-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    writeFileSync(join(root, "clean.txt"), "clean\n");
    writeFileSync(join(root, "modified.txt"), "base\n");
    execFileSync("git", ["add", "clean.txt", "modified.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "modified.txt"), "changed\n");
    writeFileSync(join(root, "untracked.txt"), "unique\n");
    assert.equal(run(root, "rm clean.txt"), undefined, "mutation is not auto-allowed");
    assert.equal(run(root, "rm modified.txt")?.action, "Ask");
    assert.equal(run(root, "rm untracked.txt", false)?.action, "Ask");
    mkdirSync(join(root, "outside")); writeFileSync(join(root, "outside", "unique.txt"), "x");
    symlinkSync(join(root, "outside"), join(root, "alias"));
    assert.equal(run(root, "rm alias/unique.txt")?.action, "Ask");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("directories never inherit recoverability and only empty scoped rmdir auto-allows", () => {
  const root = mkdtempSync(join(tmpdir(), "guardrails-local-dir-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
    mkdirSync(join(root, "mixed")); writeFileSync(join(root, "mixed", "tracked.txt"), "x");
    writeFileSync(join(root, ".gitignore"), "mixed/ignored.txt\n");
    execFileSync("git", ["add", ".gitignore", "mixed/tracked.txt"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    writeFileSync(join(root, "mixed", "ignored.txt"), "unique");
    assert.equal(run(root, "rm -rf mixed", false)?.action, "Ask");
    mkdirSync(join(root, "empty"));
    for (const judgeEnabled of [true, false]) assert.equal(run(root, "rmdir empty", judgeEnabled)?.action, "Allow");
    for (const command of ["node script.js; rmdir empty", "printf hi > output; rmdir empty", "rmdir empty > output"]) {
      assert.notEqual(run(root, command)?.action, "Allow", command);
    }
    assert.notEqual(run(root, "rmdir nonexistent")?.action, "Allow");
    assert.equal(run(root, "rmdir .")?.action, "Ask");
    const outside = join(root, "..", `${root.split("/").at(-1)}-outside`); mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"));
    assert.notEqual(run(root, "rmdir escape")?.action, "Allow");
    rmSync(outside, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
