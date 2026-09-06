import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsk } from "../src/contracts.ts";
import {
  beginWaitingNotification,
  isOrcaEnvironment,
  NOTIFICATION_COMMAND_TIMEOUT_MS,
  notifyWaiting,
  ORCA_QUESTION_PREVIEW_MAX_LENGTH,
  orcaQuestionPreview,
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

function parseOrcaSequence(sequence: string): Record<string, unknown> {
  return JSON.parse(sequence.slice("\u001b]9999;".length, -1)) as Record<string, unknown>;
}

test("Orca gets the first prompt and an idempotent cleanup instead of configured channels", () => {
  const form = normalizeAsk({ questions: [{ id: "q", label: "Short label", prompt: "Which deployment target should I use?", options: [{ value: "a", label: "A" }] }] }).form!;
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
  assert.deepEqual(parseOrcaSequence(writes[0]!), {
    state: "waiting",
    agentType: "pi",
    toolName: "ask_user",
    toolInput: "Which deployment target should I use?",
  });
  assert.doesNotMatch(writes[0]!, /Short label/);
  assert.equal(commands, 0);
  clear();
  clear();
  assert.deepEqual(parseOrcaSequence(writes[1]!), { state: "working", agentType: "pi" });
  assert.equal(writes.length, 2);
});

test("Orca preview reports multiple questions", () => {
  const form = normalizeAsk({ questions: [
    { id: "one", prompt: "Choose a scope", options: [{ value: "a", label: "A" }] },
    { id: "two", prompt: "Choose a color", options: [{ value: "b", label: "B" }] },
    { id: "three", prompt: "Confirm", options: [{ value: "c", label: "C" }] },
  ] }).form!;
  assert.equal(orcaQuestionPreview(form), "Choose a scope (3 questions)");
});

test("Orca preview strips controls and terminal escapes", () => {
  const base = normalizeAsk({ questions: [{ id: "q", prompt: "Safe", options: [{ value: "a", label: "A" }] }] }).form!;
  const form = { ...base, questions: [{ ...base.questions[0]!, prompt: "Deploy\nnow\u0007\u001b]9999;{}\u0000 okay?" }] };
  const preview = orcaQuestionPreview(form);
  assert.equal(preview, "Deploy now ]9999;{} okay?");
  assert.doesNotMatch(preview, /[\u0000-\u001f\u007f-\u009f]/u);
});

test("Orca preview truncates long Unicode without splitting a grapheme", () => {
  const family = "👨‍👩‍👧‍👦";
  const form = normalizeAsk({ questions: [{ id: "q", prompt: `${"a".repeat(148)}${family} trailing`, options: [{ value: "a", label: "A" }] }] }).form!;
  const preview = orcaQuestionPreview(form);
  assert.equal(preview, `${"a".repeat(148)}${family}…`);
  assert.ok(preview.length <= ORCA_QUESTION_PREVIEW_MAX_LENGTH);
  assert.equal(preview.includes("�"), false);
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
