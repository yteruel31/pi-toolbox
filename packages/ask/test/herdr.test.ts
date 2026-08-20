import test from "node:test";
import assert from "node:assert/strict";
import { HerdrAttention, herdrWaitingLabel } from "../src/herdr.ts";

test("balances Herdr blocked events for each active ask flow", () => {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const attention = new HerdrAttention({
    emit(event: string, payload: unknown) { emitted.push({ event, payload }); },
  } as never);

  const closeFirst = attention.block("Answer needed: First");
  const closeSecond = attention.block("Answer needed: Second");
  closeFirst();
  closeFirst();
  closeSecond();

  assert.deepEqual(emitted, [
    { event: "herdr:blocked", payload: { active: true, label: "Answer needed: First" } },
    { event: "herdr:blocked", payload: { active: true, label: "Answer needed: Second" } },
    { event: "herdr:blocked", payload: { active: false } },
    { event: "herdr:blocked", payload: { active: false } },
  ]);
});

test("clears every outstanding block during shutdown", () => {
  const emitted: unknown[] = [];
  const attention = new HerdrAttention({
    emit(_event: string, payload: unknown) { emitted.push(payload); },
  } as never);

  attention.block("One");
  attention.block("Two");
  attention.clear();
  attention.clear();

  assert.deepEqual(emitted, [
    { active: true, label: "One" },
    { active: true, label: "Two" },
    { active: false },
    { active: false },
  ]);
});

test("uses a concise title-aware blocked label", () => {
  assert.equal(herdrWaitingLabel("Deployment target"), "Answer needed: Deployment target");
  assert.equal(herdrWaitingLabel(undefined), "Answer needed");
});
