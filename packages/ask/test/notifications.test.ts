import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsk } from "../src/contracts.ts";
import {
  beginWaitingNotification,
  isOrcaEnvironment,
  NOTIFICATION_COMMAND_TIMEOUT_MS,
  notifyWaiting,
  orcaStatusSequence,
  terminalSequence,
  waitingNotification,
} from "../src/notifications.ts";

test("formats terminal notification channels", () => {
  assert.equal(NOTIFICATION_COMMAND_TIMEOUT_MS, 5_000);
  const payload = { event: "question.waiting" as const, title: "pi ask", message: "Question waiting: Scope" };
  assert.equal(terminalSequence("bell", payload), "\u0007");
  assert.match(terminalSequence("osc9", payload)!, /^\u001b\]9;/);
  assert.match(terminalSequence("osc777", payload)!, /^\u001b\]777;notify;/);
  const hostile = { ...payload, title: "pi\u0007ask", message: "Question\u001b]9999;{}\u0007" };
  assert.equal(terminalSequence("osc777", hostile), "\u001b]777;notify;pi ask;Question ]9999;{} \u0007");
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

test("Orca gets one private waiting signal and an idempotent cleanup instead of configured channels", () => {
  const form = normalizeAsk({ questions: [{ id: "q", label: "Secret question", prompt: "Q", options: [{ value: "a", label: "A" }] }] }).form!;
  const writes: string[] = [];
  let commands = 0;
  const clear = beginWaitingNotification(
    form,
    { notifications: { enabled: true, channels: ["bell", { type: "command", command: "notify" }] } },
    { write: (text) => writes.push(text), command: async () => { commands += 1; } },
    { ORCA_PANE_KEY: "tab:leaf" },
  );

  assert.equal(isOrcaEnvironment({ ORCA_PANE_KEY: "tab:leaf" }), true);
  assert.equal(isOrcaEnvironment({ ORCA_AGENT_HOOK_PORT: "1234" }), false);
  assert.deepEqual(writes, [orcaStatusSequence("waiting")]);
  assert.doesNotMatch(writes[0]!, /Secret|Question/);
  assert.equal(commands, 0);
  clear();
  clear();
  assert.deepEqual(writes, [orcaStatusSequence("waiting"), orcaStatusSequence("working")]);
});

test("non-Orca environments retain configured channels", async () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q", options: [{ value: "a", label: "A" }] }] }).form!;
  const writes: string[] = [];
  beginWaitingNotification(form, { notifications: { enabled: true, channels: ["bell"] } }, {
    write: (text) => writes.push(text),
    command: async () => {},
  }, {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes, ["\u0007"]);
});

test("disabled notifications do nothing and failures are ignored", async () => {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q", options: [{ value: "a", label: "A" }] }] }).form!;
  let called = false;
  const clear = beginWaitingNotification(form, { notifications: { enabled: false, channels: ["bell"] } }, { write: () => { called = true; }, command: async () => {} }, { ORCA_PANE_KEY: "tab:leaf" });
  clear();
  assert.equal(called, false);
  await assert.doesNotReject(() => notifyWaiting(form, { notifications: { enabled: true, channels: ["bell"] } }, { write: () => { throw new Error("no tty"); }, command: async () => {} }));
  assert.doesNotThrow(() => {
    const failedClear = beginWaitingNotification(form, { notifications: { enabled: true, channels: ["bell"] } }, { write: () => { throw new Error("no tty"); }, command: async () => {} }, { ORCA_PANE_KEY: "tab:leaf" });
    failedClear();
  });
});
