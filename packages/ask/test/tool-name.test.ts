import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import askExtension from "../src/index.ts";

const packageRoot = path.resolve(import.meta.dirname, "..");

function registeredToolNames(): string[] {
  const names: string[] = [];
  askExtension({
    events: { on() {}, emit() {} },
    registerTool(tool: { name: string }) { names.push(tool.name); },
    registerCommand() {},
    on() {},
  } as any);
  return names;
}

test("runtime, shipped skill, and public README advertise the canonical tool name", async () => {
  const names = registeredToolNames();
  assert.deepEqual(names, ["ask_user_question"]);

  const [skill, readme] = await Promise.all([
    fs.readFile(path.join(packageRoot, "skills/ask-user/SKILL.md"), "utf8"),
    fs.readFile(path.join(packageRoot, "README.md"), "utf8"),
  ]);
  assert.match(skill, /^description: Use ask_user_question /m);
  assert.match(skill, /Use `ask_user_question` when the next useful action depends/);
  assert.match(readme, /adds `ask_user_question`:/);
});
