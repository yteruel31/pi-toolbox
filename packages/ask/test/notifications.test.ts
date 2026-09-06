import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsk } from "../src/contracts.ts";
import {
  type NotificationDependencies,
  isOrcaEnvironment,
  NOTIFICATION_COMMAND_TIMEOUT_MS,
  notifyWaiting,
  terminalSequence,
  waitingNotification,
} from "../src/notifications.ts";

const form = normalizeAsk({ questions: [{ id: "q", label: "Scope", prompt: "Choose", options: [{ value: "a", label: "A" }] }] }).form!;

test("formats ordinary terminal notification channels safely", () => {
  assert.equal(NOTIFICATION_COMMAND_TIMEOUT_MS, 5_000);
  const payload = { event: "question.waiting" as const, title: "pi ask", message: "Question waiting: Scope" };
  assert.equal(terminalSequence("bell", payload), "\u0007");
  assert.match(terminalSequence("osc9", payload)!, /^\u001b\]9;/);
  assert.match(terminalSequence("osc777", payload)!, /^\u001b\]777;notify;/);
  const hostile = { ...payload, title: "pi\u0007ask", message: "Question\u001b]9999;{}\u0007" };
  assert.equal(terminalSequence("osc777", hostile), "\u001b]777;notify;pi ask;Question ]9999;{} \u0007");
});

test("outside Orca, channels run in order and commands get notification environment", async () => {
  const calls: string[] = [];
  await notifyWaiting(form, { notifications: { enabled: true, channels: ["bell", { type: "command", command: "notify" }, "osc9"] } }, {
    write: (text) => calls.push(text === "\u0007" ? "bell" : "osc9"),
    command: async (command, env) => { calls.push(`${command}:${env.ASK_NOTIFY_MESSAGE}`); },
  }, {});
  assert.deepEqual(calls, ["bell", "notify:Question waiting: Scope", "osc9"]);
  assert.equal(waitingNotification(form).title, "pi ask");
});

test("Orca suppresses every ordinary channel and emits no OSC status", async () => {
  const writes: string[] = [];
  const commands: string[] = [];
  const dependencies: NotificationDependencies = {
    write: (text) => writes.push(text),
    command: async (command) => { commands.push(command); },
  };
  await notifyWaiting(form, {
    notifications: { enabled: true, channels: ["bell", "osc9", "osc777", { type: "command", command: "notify" }] },
  }, dependencies, { ORCA_PANE_KEY: "tab:leaf" });
  assert.equal(isOrcaEnvironment({ ORCA_PANE_KEY: "tab:leaf" }), true);
  assert.equal(isOrcaEnvironment({ ORCA_AGENT_HOOK_PORT: "1234" }), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(commands, []);
});

test("disabled notifications do nothing and delivery failures remain best effort", async () => {
  let called = false;
  await notifyWaiting(form, { notifications: { enabled: false, channels: ["bell"] } }, {
    write: () => { called = true; }, command: async () => { called = true; },
  }, {});
  assert.equal(called, false);
  await assert.doesNotReject(() => notifyWaiting(form, { notifications: { enabled: true, channels: ["bell"] } }, {
    write: () => { throw new Error("no tty"); }, command: async () => {},
  }, {}));
});
