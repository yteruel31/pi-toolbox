import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAsk } from "../src/contracts.ts";
import { applyRemoteAnswers, buildResult, createAskState, draftFor, moveCursor, moveTab, requestDismiss, requestTypeToggle, selectDeclared, setCustomText, setOptionNote, setQuestionNote, serializeAnswer } from "../src/domain.ts";

function form() {
  return normalizeAsk({ title: "Plan", questions: [
    { id: "one", label: "One", prompt: "One?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    { id: "many", label: "Many", prompt: "Many?", type: "multi", options: [{ value: "x", label: "X" }, { value: "y", label: "Y" }] },
  ] }).form!;
}

test("single selection and custom text replace each other", () => {
  const state = createAskState(form());
  const question = state.form.questions[0]!;
  selectDeclared(state, question, "a");
  assert.deepEqual(serializeAnswer(state, question)?.values, ["a"]);
  setCustomText(state, question, "custom");
  assert.deepEqual(serializeAnswer(state, question), { values: ["custom"], labels: ["custom"], indices: [3], customText: "custom" });
});

test("multi answers retain option order and append custom answer", () => {
  const state = createAskState(form());
  const question = state.form.questions[1]!;
  selectDeclared(state, question, "y");
  selectDeclared(state, question, "x");
  setCustomText(state, question, "z");
  assert.deepEqual(serializeAnswer(state, question)?.values, ["x", "y", "z"]);
  assert.deepEqual(serializeAnswer(state, question)?.indices, [1, 2, 3]);
});

test("submit keeps note-only entries but only selected option notes", () => {
  const state = createAskState(form());
  setQuestionNote(state, "one", "question context");
  setOptionNote(state, "many", "x", "selected note");
  setOptionNote(state, "many", "y", "unselected note");
  selectDeclared(state, state.form.questions[1]!, "x");
  const result = buildResult(state, "submit");
  assert.deepEqual(result.details.answers.one, { values: [], labels: [], indices: [], note: "question context" });
  assert.deepEqual({ ...result.details.answers.many?.optionNotes }, { x: "selected note" });
  assert.equal(Object.getPrototypeOf(result.details.answers.many?.optionNotes), null);
  assert.match(result.content[0].text, /\[one\] One\?/);
  assert.match(result.content[0].text, /question note: "question context"/);
  assert.match(result.content[0].text, /selected option note: value "x", index 1: "selected note"/);
});

test("elaboration includes unselected option notes and continuation state", () => {
  const state = createAskState(form());
  selectDeclared(state, state.form.questions[0]!, "a");
  setOptionNote(state, "one", "b", "why not?");
  const result = buildResult(state, "elaborate");
  assert.equal(result.details.mode, "elaborate");
  assert.equal(result.details.elaboration?.items[0]?.selected, false);
  assert.equal(result.details.elaboration?.items[0]?.question.options.length, 2);
  assert.deepEqual(result.details.continuation?.affectedQuestionIds, ["one"]);
  assert.equal(result.details.continuation?.questionStates.one?.status, "needs_clarification");
  assert.match(result.content[0].text, /clarify option on \[one\]: "B" \(value "b", index 2\): "why not\?"/);
});

test("elaborate without notes still names committed answers", () => {
  const state = createAskState(form());
  selectDeclared(state, state.form.questions[0]!, "a");
  assert.match(buildResult(state, "elaborate").content[0].text, /selected: "A" \(value "a", index 1\)/);
});

test("destructive multi-to-single toggle requires a second request", () => {
  const multiForm = normalizeAsk({ questions: [{ id: "q", prompt: "Q", type: "multi", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }).form!;
  const state = createAskState(multiForm);
  selectDeclared(state, multiForm.questions[0]!, "a");
  selectDeclared(state, multiForm.questions[0]!, "b");
  assert.equal(requestTypeToggle(state, multiForm.questions[0]!), "confirm");
  assert.equal(requestTypeToggle(state, multiForm.questions[0]!), "changed");
  assert.equal(draftFor(state, "q").selected.size, 1);
});

test("result presentedType follows the final live type, not only the initial policy", () => {
  const initial = normalizeAsk({ questions: [{ id: "q", prompt: "Q", options: [{ value: "a", label: "A" }] }] }, { presentSingleAsMulti: true }).form!;
  const state = createAskState(initial);
  assert.equal(requestTypeToggle(state, initial.questions[0]!), "changed");
  selectDeclared(state, initial.questions[0]!, "a");
  assert.equal(buildResult(state, "submit").details.questions[0]?.presentedType, undefined);
});

test("agent-facing presentation note only mentions answered questions", () => {
  const initial = normalizeAsk({ questions: [
    { id: "answered", prompt: "Answered?", options: [{ value: "a", label: "A" }] },
    { id: "unanswered", prompt: "Unanswered?", options: [{ value: "b", label: "B" }] },
  ] }, { presentSingleAsMulti: true }).form!;
  const state = createAskState(initial);
  selectDeclared(state, initial.questions[0]!, "a");
  assert.match(buildResult(state, "submit").content[0].text, /answered questions used a different presentation type/);
  const onlyUnanswered = createAskState(initial);
  assert.doesNotMatch(buildResult(onlyUnanswered, "submit").content[0].text, /different presentation type/);
});

test("dirty dismiss requires the same action twice", () => {
  const state = createAskState(form());
  selectDeclared(state, state.form.questions[0]!, "a");
  assert.equal(requestDismiss(state, "dismiss", true), false);
  assert.equal(requestDismiss(state, "cancel", true), false);
  assert.equal(requestDismiss(state, "cancel", true), true);
});

test("remote answers replace state and validate canonical values", () => {
  const state = createAskState(form());
  selectDeclared(state, state.form.questions[0]!, "a");
  assert.equal(applyRemoteAnswers(state, { many: { values: ["y"], customText: "other" } }), undefined);
  assert.equal(state.answers.has("one"), false);
  assert.deepEqual(serializeAnswer(state, state.form.questions[1]!)?.labels, ["Y", "other"]);
  assert.match(applyRemoteAnswers(state, { many: { values: ["bad"] } })!, /unknown option/);
});

test("agent-facing content includes canonical ids, selections, custom text, and notes", () => {
  const state = createAskState(form());
  const question = state.form.questions[1]!;
  selectDeclared(state, question, "x");
  setCustomText(state, question, "bespoke");
  setQuestionNote(state, question.id, "context");
  setOptionNote(state, question.id, "x", "why x");
  const result = buildResult(state, "submit");
  assert.match(result.content[0].text, /\[many\] Many\?/);
  assert.match(result.content[0].text, /selected: "X" \(value "x", index 1\)/);
  assert.match(result.content[0].text, /selected: "bespoke" \(custom, index 3\)/);
  assert.match(result.content[0].text, /custom text: "bespoke"/);
  assert.match(result.content[0].text, /question note: "context"/);
  assert.match(result.content[0].text, /selected option note: value "x", index 1: "why x"/);
});

test("agent-facing content is bounded while structured details retain the full note", () => {
  const state = createAskState(form());
  const longNote = "x".repeat(100_000);
  setQuestionNote(state, "one", longNote);
  const result = buildResult(state, "submit");
  assert.ok(Buffer.byteLength(result.content[0].text, "utf8") <= 50 * 1024);
  assert.match(result.content[0].text, /Ask result truncated/);
  assert.equal(result.details.answers.one?.note, longNote);
});

test("prototype-like ids and values remain own keys in all structured records", () => {
  const special = normalizeAsk({ questions: ["__proto__", "constructor", "prototype"].map((id) => ({
    id, prompt: id, type: "multi", options: [{ value: id, label: id }],
  })) }).form!;
  const state = createAskState(special);
  for (const question of special.questions) {
    selectDeclared(state, question, question.options[0]!.value);
    setOptionNote(state, question.id, question.options[0]!.value, `note-${question.id}`);
  }
  const result = buildResult(state, "submit");
  assert.equal(Object.getPrototypeOf(result.details.answers), null);
  for (const id of ["__proto__", "constructor", "prototype"]) {
    assert.equal(Object.hasOwn(result.details.answers, id), true);
    assert.equal(Object.getPrototypeOf(result.details.answers[id]!.optionNotes), null);
    assert.equal(result.details.answers[id]!.optionNotes?.[id], `note-${id}`);
  }
  const elaborated = buildResult(state, "elaborate");
  assert.equal(Object.getPrototypeOf(elaborated.details.continuation?.preservedAnswers), null);
  assert.equal(Object.getPrototypeOf(elaborated.details.continuation?.questionStates), null);
  assert.equal(Object.hasOwn(elaborated.details.continuation!.questionStates, "__proto__"), true);
});

test("review shortcut survives cursor movement but all transients clear on tab change", () => {
  const state = createAskState(form());
  state.tab = state.form.questions.length;
  state.pendingReviewShortcut = 0;
  moveCursor(state, 1);
  assert.equal(state.pendingReviewShortcut, 0);
  moveTab(state, -1);
  assert.equal(state.pendingReviewShortcut, undefined);
  state.pendingTypeChange = "many";
  moveCursor(state, 1);
  assert.equal(state.pendingTypeChange, undefined);
});
