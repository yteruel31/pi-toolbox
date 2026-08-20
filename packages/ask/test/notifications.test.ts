import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsk } from "../src/contracts.ts";
import { NOTIFICATION_COMMAND_TIMEOUT_MS, notifyWaiting, terminalSequence, waitingNotification } from "../src/notifications.ts";

test("formats terminal notification channels", () => {
  assert.equal(NOTIFICATION_COMMAND_TIMEOUT_MS, 5_000);
  const payload = { event: "question.waiting" as const, title: "pi ask", message: "Question waiting: Scope" };
  assert.equal(terminalSequence("bell", payload), "\u0007");
  assert.match(terminalSequence("osc9", payload)!, /^\u001b\]9;/);
  assert.match(terminalSequence("osc777", payload)!, /^\u001b\]777;notify;/);
});

test("channels run in order and command gets environment", async () => {
  const form = normalizeAsk({ questions: [{ id: "q", label: "Scope", prompt: "Choose", options: [{ value: "a", label: "A" }] }] }).form!;
  const calls: string[] = [];
  await notifyWaiting(form, { notifications: { enabled: true, channels: ["bell", { type: "command", command: "notify" }, "osc9"] } }, {
    write: (text) => calls.push(text === "\u0007" ? "bell" : "osc9"),
    command: async (command, env) => { calls.push(`${command}:${env.ASK_NOTIFY_MESSAGE}`); },
  });
  assert.deepEqual(calls, ["bell", "notify:Question waiting: Scope", "osc9"]);
  assert.equal(waitingNotification(form).title, "pi ask");
});

test("disabled notifications do nothing and failures are ignored", async () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q", options: [{ value: "a", label: "A" }] }] }).form!;
  let called = false;
  await notifyWaiting(form, { notifications: { enabled: false, channels: ["bell"] } }, { write: () => { called = true; }, command: async () => {} });
  assert.equal(called, false);
  await assert.doesNotReject(() => notifyWaiting(form, { notifications: { enabled: true, channels: ["bell"] } }, { write: () => { throw new Error("no tty"); }, command: async () => {} }));
});
