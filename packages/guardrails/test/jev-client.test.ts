import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetch } from "@typesafe-ai/sdk";
import { judgeJev } from "../src/jev-client.js";
import { candidate, config, policy } from "./helpers.js";

const natural = (id: string, action: "Allow" | "Ask" | "Deny", description: string) => policy({ id, action, description, kind: "natural" });
function reply(probabilities = { Allow: .95, Ask: .04, Deny: .01 }, restrictions: number[] = [], model = "jev-returned") {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  return { model, usage: { input_tokens: 1, output_tokens: 1 }, answers: { decision: { type: "choice", choice, confidence: Math.max(...Object.values(probabilities)), probabilities }, ...Object.fromEntries(restrictions.map((n, i) => [`restriction_${i}`, { type: "noul", noul: n }])) } };
}
function fake(value: unknown, inspect?: (body: any, init?: RequestInit) => void): Fetch {
  return async (_input, init) => { inspect?.(JSON.parse(String(init?.body)), init); return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); };
}
const assess = (value: unknown, policies = [] as ReturnType<typeof natural>[], fetchImpl = fake(value), extra = {}) => judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate(), policies, history: [], target: "/project", operation: "git status", fetchImpl, ...extra });

test("SDK request has one policy-specific question per natural restriction and safe transport settings", async () => {
  const rules = [natural("prod", "Deny", "Never modify production"), natural("secret", "Ask", "Review access to credentials")];
  let calls = 0;
  const result = await assess(reply(undefined, [0, 0]), rules, fake(reply(undefined, [0, 0]), (body, init) => {
    calls++; assert.equal(body.model, "jev-latest"); assert.deepEqual(Object.keys(body.questions), ["decision", "restriction_0", "restriction_1"]);
    assert.match(JSON.stringify(body.questions.restriction_0), /Never modify production/); assert.doesNotMatch(JSON.stringify(body.questions.restriction_0), /Review access/);
    assert.match(JSON.stringify(body.questions.restriction_1), /Review access to credentials/); assert.equal(init?.redirect, "error");
  }));
  assert.equal(calls, 1); assert.equal(result.action, "Allow"); assert.equal(result.model?.route, "typesafe/jev-returned");
});

test("threshold boundaries combine generic verdict and restrictive policies conservatively", async () => {
  const rules = [natural("deny", "Deny", "Never deploy"), natural("allow", "Allow", "Routine checks")];
  assert.equal((await assess(reply({ Allow: .95, Ask: .04, Deny: .01 }, [.05]), rules)).action, "Allow");
  assert.equal((await assess(reply({ Allow: .95, Ask: .04, Deny: .01 }, [.051]), rules)).action, "Ask");
  assert.equal((await assess(reply({ Allow: .1, Ask: .1, Deny: .8 }, [0]), rules)).action, "Deny");
  assert.equal((await assess(reply({ Allow: .7, Ask: .2, Deny: .1 }, [.8]), rules)).action, "Deny");
  let questions: string[] = [];
  assert.equal((await assess(reply({ Allow: .95, Ask: .04, Deny: .01 }, [0]), rules, fake(reply({ Allow: .95, Ask: .04, Deny: .01 }, [0]), (body) => { questions = Object.keys(body.questions); }))).action, "Allow");
  assert.deepEqual(questions, ["decision", "restriction_0"], "natural Allow is authoritative state but never a Noul restriction");
});

test("malformed, oversized, retryable HTTP, cancellation and redacted candidates fail closed without retries", async () => {
  assert.equal((await assess({ model: "x", answers: {} })).origin, "error");
  let calls = 0; const failure: Fetch = async () => { calls++; return new Response("busy", { status: 503 }); };
  assert.equal((await assess({}, [], failure)).action, "Ask"); assert.equal(calls, 1);
  assert.equal((await assess({}, [], async () => new Response("x".repeat(300000), { headers: { "content-length": "300000" } }))).origin, "error");
  const cancelled = new AbortController(); cancelled.abort(); assert.equal((await assess(reply(), [], fake(reply()), { signal: cancelled.signal })).action, "Deny");
  const redacted = await judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate({ tool: "write", args: { path: "a", content: "secret" } }), policies: [], history: [], target: "/project/a", operation: "write", fetchImpl: fake(reply()) });
  assert.equal(redacted.action, "Ask");
});

test("up to 200 merged restrictions are represented; larger sets fail closed rather than truncate", async () => {
  const twoHundred = Array.from({ length: 200 }, (_, i) => natural(`p${i}`, "Ask", `Restriction ${i}`));
  assert.equal((await assess(reply(undefined, Array(200).fill(0)), twoHundred)).action, "Allow");
  assert.equal((await assess(reply(undefined, Array(201).fill(0)), [...twoHundred, natural("extra", "Deny", "extra")])).origin, "error");
});
