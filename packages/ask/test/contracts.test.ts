import test from "node:test";
import assert from "node:assert/strict";
import { invalidAskResult, normalizeAsk, prepareAskArguments } from "../src/contracts.ts";

const valid = { title: "  Choose  ", questions: [{ id: "target", prompt: " Pick one ", options: [{ value: "fast_path", label: " Fast " }] }] };

test("normalizes defaults and optional whitespace", () => {
  const result = normalizeAsk(valid);
  assert.deepEqual(result.issues, []);
  assert.equal(result.form?.title, "Choose");
  assert.deepEqual(result.form?.questions[0], {
    id: "target", label: "Q1", prompt: "Pick one", type: "single", required: false,
    options: [{ value: "fast_path", label: "Fast" }],
  });
});

test("normalization strips terminal control sequences from rendered and canonical text", () => {
  const result = normalizeAsk({
    title: "Demo\u001b]52;c;clipboard\u0007",
    questions: [{
      id: "q\u001b[31m",
      prompt: "Choose\u001b[2J now",
      options: [{ value: "safe\u001b]9;notify\u0007", label: "Option\u001b[31m" }],
    }],
  });
  assert.equal(result.form?.title, "Demo]52;c;clipboard");
  assert.equal(result.form?.questions[0]?.id, "q[31m");
  assert.equal(result.form?.questions[0]?.prompt, "Choose[2J now");
  assert.equal(result.form?.questions[0]?.options[0]?.value, "safe]9;notify");
  assert.equal(result.form?.questions[0]?.options[0]?.label, "Option[31m");
});

test("preparation derives a missing public option label", () => {
  const prepared = prepareAskArguments({ questions: [{ id: "x", prompt: "X?", options: [{ value: "fast_path" }] }] });
  assert.equal((prepared as any).questions[0].options[0].label, "Fast path");
  assert.equal(normalizeAsk(prepared).form?.questions[0]?.options[0]?.label, "Fast path");
});

test("reports uniqueness, trimmed text, and preview requirements with paths", () => {
  const result = normalizeAsk({ questions: [
    { id: "same", prompt: " ", type: "preview", options: [{ value: "v", label: "V", description: "not a preview" }] },
    { id: "same", prompt: "ok", options: [{ value: "v", label: "V" }, { value: "v", label: "Again" }] },
  ] });
  assert.equal(result.form, undefined);
  assert.ok(result.issues.some((issue) => issue.path === "questions[0].prompt"));
  assert.ok(result.issues.some((issue) => issue.path.endsWith("preview") && issue.message.includes("use type single")));
  assert.ok(result.issues.some((issue) => issue.message.includes("duplicate question")));
  assert.ok(result.issues.some((issue) => issue.message.includes("duplicate option")));
});

test("internal freeform is accepted only for extraction", () => {
  const payload = { questions: [{ id: "open", prompt: "Explain", freeform: true, options: [] }] };
  assert.equal(normalizeAsk(payload).form, undefined);
  assert.equal(normalizeAsk(payload, { allowInternalFreeform: true }).form?.questions[0]?.freeform, true);
});

test("presentSingleAsMulti preserves requested type", () => {
  const question = normalizeAsk(valid, { presentSingleAsMulti: true }).form?.questions[0];
  assert.equal(question?.type, "single");
  assert.equal(question?.presentedType, "multi");
});

test("invalid result is structured and transcript-friendly", () => {
  const result = invalidAskResult({}, [{ path: "questions", message: "missing" }]);
  assert.equal(result.details.cancelled, true);
  assert.equal(result.details.error?.kind, "invalid_input");
  assert.match(result.content[0].text, /^Invalid ask_user payload:/);
});
