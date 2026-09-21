import { test } from "node:test";
import assert from "node:assert/strict";
import { createEditTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { canonicalPath } from "../src/policies.js";

const signal = new AbortController().signal;

async function nativeWritePath(path: string, cwd: string): Promise<string> {
  let captured = "";
  const tool = createWriteTool(cwd, { operations: {
    mkdir: async () => {},
    writeFile: async (absolutePath) => { captured = absolutePath; },
  } });
  await tool.execute("compat-write", { path, content: "benign fixture" }, signal, () => {});
  return captured;
}

async function nativeEditPath(path: string, cwd: string): Promise<string> {
  let captured = "";
  const tool = createEditTool(cwd, { operations: {
    access: async (absolutePath) => { captured = absolutePath; },
    readFile: async (absolutePath) => { captured = absolutePath; return Buffer.from("before"); },
    writeFile: async (absolutePath) => { captured = absolutePath; },
  } });
  await tool.execute("compat-edit", { path, edits: [{ oldText: "before", newText: "after" }] }, signal, () => {});
  return captured;
}

test("guardrails canonical native paths match public Pi write/edit tools", async () => {
  const cwd = "/tmp/guardrails-native-path-contract";
  const inputs = [
    "@alias/../.pi/settings.json",
    "folder/../file.txt",
    "name\u2007with-space.txt",
    `file://${cwd}/folder/../url-target.txt`,
  ];
  for (const input of inputs) {
    const guarded = canonicalPath(input, cwd);
    assert.equal(await nativeWritePath(input, cwd), guarded, `write: ${input}`);
    assert.equal(await nativeEditPath(input, cwd), guarded, `edit: ${input}`);
  }
});
