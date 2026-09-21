import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetch } from "@typesafe-ai/sdk";
import { judgeJev } from "../src/jev-client.js";
import { candidate, config, policy } from "./helpers.js";

const natural = (id: string, action: "Allow" | "Ask" | "Deny", description: string) => policy({ id, action, description, kind: "natural" });
function reply(probabilities = { Allow: .95, Ask: .04, Deny: .01 }, restrictions: number[] = [], model = "jev-returned", risks: number[] = [0, 0, 0, 0, 0]) {
  const choice = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
  const names = ["sensitive-transfer", "external-modification", "unrecoverable-loss", "guardrail-modification", "uncertainty"];
  return { model, usage: { input_tokens: 1, output_tokens: 1 }, answers: { decision: { type: "choice", choice, confidence: Math.max(...Object.values(probabilities)), probabilities }, ...Object.fromEntries(names.map((name, i) => [`risk_${name}`, { type: "noul", noul: risks[i] ?? 0 }])), ...Object.fromEntries(restrictions.map((n, i) => [`restriction_${i}`, { type: "noul", noul: n }])) } };
}
function fake(value: unknown, inspect?: (body: any, init?: RequestInit) => void): Fetch {
  return async (_input, init) => { inspect?.(JSON.parse(String(init?.body)), init); return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } }); };
}
const assess = (value: unknown, policies = [] as ReturnType<typeof natural>[], fetchImpl = fake(value), extra = {}) => judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate(), policies, history: [], target: "/project", operation: "git status", fetchImpl, ...extra });

test("SDK request has one policy-specific question per natural restriction and safe transport settings", async () => {
  const rules = [natural("prod", "Deny", "Never modify production"), natural("secret", "Ask", "Review access to credentials")];
  let calls = 0;
  const result = await assess(reply(undefined, [0, 0]), rules, fake(reply(undefined, [0, 0]), (body, init) => {
    calls++; assert.equal(body.model, "jev-latest"); assert.deepEqual(Object.keys(body.questions), ["decision", "risk_sensitive-transfer", "risk_external-modification", "risk_unrecoverable-loss", "risk_guardrail-modification", "risk_uncertainty", "restriction_0", "restriction_1"]);
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
  assert.deepEqual(questions, ["decision", "risk_sensitive-transfer", "risk_external-modification", "risk_unrecoverable-loss", "risk_guardrail-modification", "risk_uncertainty", "restriction_0"], "natural Allow is authoritative state but never a Noul restriction");
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

test("bounded arithmetic scripts preserve classifier evidence while arbitrary or sensitive scripts stay incomplete", async () => {
  for (const command of ["python3 -c 'print(2 + 2)'", "python -c \"print((8 * 3) - 1)\""]) {
    let candidateState: any;
    const result = await judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate({ args: { command } }), policies: [], history: [], target: "/project", operation: "shell-complex", fetchImpl: fake(reply(), (body) => { candidateState = body.state.untrusted_candidate; }) });
    assert.equal(result.action, "Allow", command);
    assert.equal(candidateState.assessmentIncomplete, false);
    assert.equal(candidateState.args.command, command, "classifier evidence preserves executable syntax");
  }
  for (const command of [
    "python3 -c 'print(secret)'", "python3 -c 'import os; print(os.environ)'", "python3 -c 'print(2 + \\\n2)'",
    "python3 -c 'print(2 + 2)'\npython3 -c 'print(3)'", "TOKEN='hidden' python3 -c 'print(2 + 2)'",
    "python3 -c 'print(\"-----BEGIN PRIVATE KEY-----\")'", "python3 -c 'print(1234567890123456789012345678901234567890)'",
    "python3 -c 'print(2 + $VALUE)'", "python3 -c 'print(2 + 2)'; touch file", "python3 -c 'print(2 +)'",
    "python3 -c 'print((2 + 2)'", "python3 -c 'print(2 2)'", "python3 -c 'print(2 + \u0007 2)'",
  ]) {
    let candidateState: any;
    const result = await judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate({ args: { command } }), policies: [], history: [], target: "/project", operation: "shell-complex", fetchImpl: fake(reply(), (body) => { candidateState = body.state.untrusted_candidate; }) });
    assert.equal(result.action, "Ask", command);
    assert.equal(candidateState.assessmentIncomplete, true);
    assert.doesNotMatch(JSON.stringify(candidateState), /hidden|os\.environ|PRIVATE KEY/);
    assert.match(result.reason, /^Assessment evidence has gaps/);
  }
});

test("multiline and oversized shell evidence stays bounded and fail-closed", async () => {
  let serialized = "";
  const multiline = await judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate({ args: { command: "python3 -c 'print(2)'\npython3 -c 'print(3)'" } }), policies: [], history: [], target: "/project", operation: "shell-complex", fetchImpl: fake(reply(), (body) => { serialized = JSON.stringify(body.state.untrusted_candidate); }) });
  assert.equal(multiline.action, "Ask"); assert.ok(serialized.length < 5000); assert.doesNotMatch(serialized, /print\(2\)/);
  let calls = 0;
  const oversized = await judgeJev({ config: config({ backend: "jev" }), apiKey: "key", candidate: candidate({ args: { command: `python3 -c '${"2 + ".repeat(5000)}2'` } }), policies: [], history: [], target: "/project", operation: "shell-complex", fetchImpl: fake(reply(), () => { calls++; }) });
  assert.equal(oversized.action, "Ask"); assert.equal(oversized.origin, "model"); assert.equal(calls, 1); assert.match(oversized.reason, /^Assessment evidence has gaps/);
});

test("up to 200 merged restrictions are represented; larger sets fail closed rather than truncate", async () => {
  const twoHundred = Array.from({ length: 200 }, (_, i) => natural(`p${i}`, "Ask", `Restriction ${i}`));
  assert.equal((await assess(reply(undefined, Array(200).fill(0)), twoHundred)).action, "Allow");
  assert.equal((await assess(reply(undefined, Array(201).fill(0)), [...twoHundred, natural("extra", "Deny", "extra")])).origin, "error");
});
