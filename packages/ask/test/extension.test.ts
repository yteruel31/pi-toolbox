import test from "node:test";
import assert from "node:assert/strict";
import askExtension, { recoverAskForm } from "../src/index.ts";

function harness() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const entries: any[] = [];
  const api: any = {
    events: { on() {}, emit() {} },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand(name: string, command: any) { commands.set(name, command); },
    on(name: string, handler: any) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
    sendUserMessage() {},
  };
  askExtension(api);
  return { tools, commands, handlers, entries };
}

test("extension registers one strict ask tool and all command surfaces", () => {
  const { tools, commands } = harness();
  const tool = tools.get("ask_user");
  assert.ok(tool);
  assert.equal(tool.parameters.required.includes("questions"), true);
  const option = tool.parameters.properties.questions.items.properties.options.items;
  assert.equal(option.required.includes("label"), true);
  assert.deepEqual([...commands.keys()].sort(), ["answer", "answer:again", "ask-settings", "ask:replay"]);
});

test("print mode returns pending normalized choices without opening custom UI", async () => {
  const { tools, entries } = harness();
  let opened = false;
  const result = await tools.get("ask_user").execute("call", {
    questions: [{ id: "q", prompt: "Choose", options: [{ value: "a", label: "A" }] }],
  }, undefined, undefined, { mode: "print", ui: { custom() { opened = true; } } });
  assert.equal(opened, false);
  assert.equal(result.details.cancelled, true);
  assert.match(result.content[0].text, /^Needs user input:/);
  assert.match(result.content[0].text, /1\. A \(a\)/);
  assert.equal(entries[0].type, "yteruel31-pi-ask:payload");
});

test("semantic invalid input returns structured issues before persistence", async () => {
  const { tools, entries } = harness();
  const result = await tools.get("ask_user").execute("call", {
    questions: [{ id: "q", prompt: " ", options: [{ value: "a", label: "A" }] }],
  }, undefined, undefined, { mode: "print" });
  assert.equal(result.details.error.kind, "invalid_input");
  assert.equal(entries.length, 0);
});

test("recovery validates persisted params then falls back to original arguments", () => {
  const original = { questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] };
  const recovered = recoverAskForm({ questions: [] }, original);
  assert.equal(recovered.source, "original");
  assert.equal(recovered.form?.questions[0]?.id, "q");
  assert.equal(recoverAskForm({ questions: [] }, { questions: [] }).source, "invalid");
});

test("reload does not recover and unrecoverable startup writes a dismissal marker", async () => {
  const { handlers, entries } = harness();
  const sessionStart = handlers.get("session_start")![0];
  const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "ask_user", arguments: { questions: [] } }] } }];
  const ctx = { mode: "tui", ui: { notify() {} }, sessionManager: { getBranch: () => branch } };
  await sessionStart({ reason: "reload" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(entries.length, 0);
  await sessionStart({ reason: "startup" }, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(entries.some((entry) => entry.type === "yteruel31-pi-ask:pending-dismissed" && entry.data.reason === "invalid_payload"));
});
