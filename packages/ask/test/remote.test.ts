import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsk } from "../src/contracts.ts";
import { REMOTE_EVENTS, RemoteAskRegistry } from "../src/remote.ts";

class Bus {
  listeners = new Map<string, Array<(event: unknown) => void>>();
  emitted: Array<[string, any]> = [];
  on(name: string, listener: (event: unknown) => void) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]); }
  emit(name: string, event: unknown) { this.emitted.push([name, event]); for (const listener of this.listeners.get(name) ?? []) listener(event); }
}

function make() {
  const bus = new Bus();
  const registry = new RemoteAskRegistry(bus);
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q?", options: [{ value: "yes", label: "Yes" }] }] }).form!;
  return { bus, registry, form };
}

test("started and completed events use versioned package namespace", () => {
  const { bus, registry, form } = make();
  const flow = registry.open(form, "tool", () => {}, "call-1");
  assert.equal(bus.emitted[0]?.[0], "@yteruel31/pi-ask:started");
  assert.equal(bus.emitted[0]?.[1].version, 1);
  registry.complete(flow.flowId, { content: [{ type: "text", text: "done" }], details: { cancelled: false, mode: "submit", questions: [], answers: {} } });
  assert.equal(bus.emitted.at(-1)?.[0], REMOTE_EVENTS.completed);
});

test("remote answer validates values and recomputes canonical labels", () => {
  const { bus, registry, form } = make();
  let result: any;
  const flow = registry.open(form, "tool", (value) => { result = value; });
  bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId: "r1", flowId: flow.flowId, response: { kind: "answer", answers: { q: { values: ["yes"] } } } });
  assert.equal(result.details.answers.q.labels[0], "Yes");
  assert.equal(result.details.answers.q.indices[0], 1);
  assert.equal(bus.emitted.find(([name, event]) => name === REMOTE_EVENTS.submitResult && event.requestId === "r1")?.[1].ok, true);
});

test("invalid and unknown-flow submissions receive explicit errors", () => {
  const { bus, registry, form } = make();
  const flow = registry.open(form, "tool", () => {});
  bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId: "bad", flowId: flow.flowId, response: { kind: "answer", answers: { q: { values: ["approve-ish"] } } } });
  bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId: "missing", flowId: "none", response: { kind: "cancel" } });
  const results = bus.emitted.filter(([name]) => name === REMOTE_EVENTS.submitResult).map(([, event]) => event);
  assert.equal(results.find((event) => event.requestId === "bad").error, "invalid_answer");
  assert.equal(results.find((event) => event.requestId === "missing").error, "flow_not_found");
});

test("cancel is explicit", () => {
  const { bus, registry, form } = make();
  let result: any;
  const flow = registry.open(form, "ask:replay", (value) => { result = value; });
  bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId: "cancel", flowId: flow.flowId, response: { kind: "cancel" } });
  assert.equal(result.details.cancelled, true);
});

test("first accepted submission deactivates atomically and completion emits once", () => {
  const { bus, registry, form } = make();
  let result: any;
  const flow = registry.open(form, "tool", (value) => { result = value; });
  const answer = (requestId: string) => bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId, flowId: flow.flowId, response: { kind: "answer", answers: { q: { values: ["yes"] } } } });
  answer("first");
  answer("second");
  const second = bus.emitted.find(([name, event]) => name === REMOTE_EVENTS.submitResult && event.requestId === "second")?.[1];
  assert.equal(second.error, "flow_not_found");
  registry.complete(flow.flowId, result);
  registry.complete(flow.flowId, result);
  assert.equal(bus.emitted.filter(([name]) => name === REMOTE_EVENTS.completed).length, 1);
});

test("throwing remote UI still produces one completed event", () => {
  const { bus, registry, form } = make();
  const flow = registry.open(form, "tool", () => { throw new Error("UI failed"); });
  bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId: "r", flowId: flow.flowId, response: { kind: "cancel" } });
  assert.equal(bus.emitted.filter(([name]) => name === REMOTE_EVENTS.completed).length, 1);
});

test("remote input preserves prototype-like ids and values safely", () => {
  const bus = new Bus();
  const registry = new RemoteAskRegistry(bus);
  const form = normalizeAsk({ questions: [{ id: "__proto__", prompt: "Q?", options: [{ value: "constructor", label: "Constructor" }] }] }).form!;
  let result: any;
  const flow = registry.open(form, "tool", (value) => { result = value; });
  const answers = Object.create(null);
  answers.__proto__ = { values: ["constructor"], optionNotes: JSON.parse('{"constructor":"safe"}') };
  bus.emit(REMOTE_EVENTS.submit, { version: 1, requestId: "safe", flowId: flow.flowId, response: { kind: "answer", answers } });
  assert.equal(Object.getPrototypeOf(result.details.answers), null);
  assert.equal(Object.hasOwn(result.details.answers, "__proto__"), true);
  assert.equal(result.details.answers.__proto__.optionNotes.constructor, "safe");
});
