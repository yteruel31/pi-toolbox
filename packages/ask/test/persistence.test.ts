import test from "node:test";
import assert from "node:assert/strict";
import { DISMISSED_ENTRY, findPendingAsk, latestPayload, makePayload, payloadFromEntry, PAYLOAD_ENTRY } from "../src/persistence.ts";

const toolCall = (id: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "ask_user", arguments: { questions: [{ id: "q", prompt: "Q", options: [{ value: "a", label: "A" }] }] } }] } });

test("payload lookup is branch-local and source-aware", () => {
  const first = makePayload("tool", { title: "first" }, "a");
  const extracted = makePayload("answer", { title: "answer" });
  const branch = [{ type: "custom", customType: PAYLOAD_ENTRY, data: first }, { type: "custom", customType: PAYLOAD_ENTRY, data: extracted }];
  assert.equal(latestPayload(branch, ["tool"])?.params && (latestPayload(branch, ["tool"])!.params as any).title, "first");
  assert.equal((latestPayload(branch, ["answer"])!.params as any).title, "answer");
});

test("recovery selects newest unresolved ask and prefers matching payload", () => {
  const persisted = makePayload("tool", { title: "persisted" }, "new");
  const branch = [
    toolCall("old"),
    { type: "message", message: { role: "toolResult", toolCallId: "old", toolName: "ask_user" } },
    toolCall("new"),
    { type: "custom", customType: PAYLOAD_ENTRY, data: persisted },
  ];
  const pending = findPendingAsk(branch);
  assert.equal(pending?.toolCallId, "new");
  assert.equal((pending?.payload?.params as any).title, "persisted");
});

test("dismissal markers suppress automatic recovery", () => {
  const branch = [toolCall("pending"), { type: "custom", customType: DISMISSED_ENTRY, data: { toolCallId: "pending" } }];
  assert.equal(findPendingAsk(branch), undefined);
});

test("sibling entries are naturally ignored when caller provides active branch", () => {
  const active = [toolCall("active")];
  const sibling = [...active, toolCall("sibling")];
  assert.equal(findPendingAsk(active)?.toolCallId, "active");
  assert.equal(findPendingAsk(sibling)?.toolCallId, "sibling");
});

test("persisted payload envelope is validated before recovery", () => {
  assert.equal(payloadFromEntry({ type: "custom", customType: PAYLOAD_ENTRY, data: { version: 1, source: "reload", params: {}, createdAt: Date.now() } }), undefined);
  assert.equal(payloadFromEntry({ type: "custom", customType: PAYLOAD_ENTRY, data: { version: 1, source: "tool", params: {} } }), undefined);
  assert.equal(payloadFromEntry({ type: "custom", customType: PAYLOAD_ENTRY, data: makePayload("tool", {}) })?.source, "tool");
});
