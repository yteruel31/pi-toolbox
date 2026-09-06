import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { checkPiPackages } from "../src/prerequisites/check-pi-packages.ts";

const source = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("Claude AskUserQuestion mappings target the public Pi question tool", async () => {
  const [skills, agents] = await Promise.all([
    source("../src/components/skills.ts"),
    source("../src/components/agents.ts"),
  ]);
  assert.match(skills, /AskUserQuestion\\b\/g, "ask_user_question"/);
  assert.match(agents, /AskUserQuestion: "ask_user_question"/);
  assert.match(agents, /AskUserQuestion\\b\/g, "ask_user_question"/);
  assert.doesNotMatch(skills, /"ask_user"/);
  assert.doesNotMatch(agents, /AskUserQuestion: "ask_user"/);
});

test("marketplace prerequisite detects ask_user_question and not the historical name", () => {
  const statusFor = (names: string[]) => checkPiPackages({ getAllTools: () => names.map((name) => ({ name })) } as any)[0]!;
  assert.equal(statusFor(["ask_user_question"]).installed, true);
  assert.equal(statusFor(["ask_user"]).installed, false);
  assert.equal(statusFor(["ask_user_question"]).toolName, "ask_user_question");
});
