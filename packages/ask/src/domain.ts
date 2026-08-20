import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import {
  type AskAnswer,
  type AskForm,
  type AskQuestion,
  type AskResult,
  type ElaborationItem,
  type AskType,
  questionMetadata,
  safeRecord,
  sanitizeText,
} from "./contracts.ts";

export interface DraftAnswer {
  selected: Set<string>;
  customText?: string;
  customSelected: boolean;
  note?: string;
  optionNotes: Map<string, string>;
}

export interface AskState {
  form: AskForm;
  tab: number;
  cursor: number;
  reviewCursor: number;
  answers: Map<string, DraftAnswer>;
  presentedTypes: Map<string, AskType>;
  pendingTypeChange?: string;
  dirtyDismiss?: "dismiss" | "cancel";
  pendingReviewShortcut?: number;
}

export function createAskState(form: AskForm): AskState {
  return {
    form,
    tab: 0,
    cursor: 0,
    reviewCursor: 0,
    answers: new Map(),
    presentedTypes: new Map(form.questions.map((question) => [question.id, question.presentedType ?? question.type])),
  };
}

export function activeQuestion(state: AskState): AskQuestion | undefined {
  return state.form.questions[state.tab];
}

export function draftFor(state: AskState, id: string): DraftAnswer {
  let draft = state.answers.get(id);
  if (!draft) {
    draft = { selected: new Set(), customSelected: false, optionNotes: new Map() };
    state.answers.set(id, draft);
  }
  return draft;
}

export function presentedType(state: AskState, question: AskQuestion): AskType {
  return state.presentedTypes.get(question.id) ?? question.presentedType ?? question.type;
}

export function clearTypeConfirmation(state: AskState): void {
  state.pendingTypeChange = undefined;
}

function clearAnswerTransients(state: AskState): void {
  state.pendingTypeChange = undefined;
  state.pendingReviewShortcut = undefined;
}

export function moveTab(state: AskState, delta: number): void {
  const count = state.form.questions.length + 1;
  state.tab = (state.tab + delta + count) % count;
  state.cursor = 0;
  state.reviewCursor = 0;
  state.dirtyDismiss = undefined;
  clearAnswerTransients(state);
}

export function moveCursor(state: AskState, delta: number): void {
  const question = activeQuestion(state);
  const count = question ? Math.max(1, question.options.length + (question.freeform ? 0 : 1)) : 3;
  if (question) {
    state.cursor = Math.max(0, Math.min(count - 1, state.cursor + delta));
    clearTypeConfirmation(state);
  } else {
    // A review numeric shortcut remains armed while the user inspects another row.
    state.reviewCursor = Math.max(0, Math.min(2, state.reviewCursor + delta));
  }
}

export function selectDeclared(state: AskState, question: AskQuestion, value: string): void {
  const draft = draftFor(state, question.id);
  if (presentedType(state, question) === "multi") {
    if (draft.selected.has(value)) draft.selected.delete(value);
    else draft.selected.add(value);
  } else {
    draft.selected.clear();
    draft.selected.add(value);
    draft.customSelected = false;
    draft.customText = undefined;
  }
  clearAnswerTransients(state);
}

export function setCustomText(state: AskState, question: AskQuestion, text: string): void {
  const draft = draftFor(state, question.id);
  const value = sanitizeText(text).trim();
  if (value) draft.customText = value;
  else draft.customText = undefined;
  if (presentedType(state, question) === "multi") {
    draft.customSelected = Boolean(value);
  } else {
    draft.selected.clear();
    draft.customSelected = Boolean(value);
  }
  clearAnswerTransients(state);
}

export function toggleCustom(state: AskState, question: AskQuestion): "edit" | "toggled" {
  const draft = draftFor(state, question.id);
  if (!draft.customText) return "edit";
  if (presentedType(state, question) === "multi") {
    draft.customSelected = !draft.customSelected;
  } else {
    draft.selected.clear();
    draft.customSelected = true;
  }
  clearAnswerTransients(state);
  return "toggled";
}

export function setQuestionNote(state: AskState, questionId: string, note: string): void {
  const draft = draftFor(state, questionId);
  const clean = sanitizeText(note).trim();
  if (clean) draft.note = clean;
  else draft.note = undefined;
}

export function setOptionNote(state: AskState, questionId: string, value: string, note: string): void {
  const draft = draftFor(state, questionId);
  const clean = sanitizeText(note).trim();
  if (clean) draft.optionNotes.set(value, clean);
  else draft.optionNotes.delete(value);
}

export function requestTypeToggle(state: AskState, question: AskQuestion): "changed" | "confirm" {
  const current = presentedType(state, question);
  const next: AskType = current === "multi" ? (question.type === "preview" ? "preview" : "single") : "multi";
  const selectedCount = draftFor(state, question.id).selected.size + (draftFor(state, question.id).customSelected ? 1 : 0);
  if (current === "multi" && selectedCount > 1 && state.pendingTypeChange !== question.id) {
    state.pendingTypeChange = question.id;
    return "confirm";
  }
  if (next !== "multi") {
    const draft = draftFor(state, question.id);
    const keep = question.options.find((option) => draft.selected.has(option.value));
    draft.selected.clear();
    if (keep) {
      draft.selected.add(keep.value);
      draft.customSelected = false;
    } else if (draft.customText) {
      draft.customSelected = true;
    }
  }
  state.presentedTypes.set(question.id, next);
  state.pendingTypeChange = undefined;
  return "changed";
}

export function isAnswered(state: AskState, question: AskQuestion): boolean {
  const draft = state.answers.get(question.id);
  return Boolean(draft && (draft.selected.size > 0 || (draft.customSelected && draft.customText)));
}

export function hasAnyNotes(state: AskState): boolean {
  for (const draft of state.answers.values()) {
    if (draft.note || draft.optionNotes.size > 0) return true;
  }
  return false;
}

export function allAnswered(state: AskState): boolean {
  return state.form.questions.every((question) => isAnswered(state, question));
}

export function isDirty(state: AskState, editorDraft = ""): boolean {
  if (editorDraft.length > 0) return true;
  for (const [id, draft] of state.answers) {
    if (!state.form.questions.some((question) => question.id === id)) continue;
    if (draft.selected.size || draft.customText || draft.note || draft.optionNotes.size) return true;
  }
  return false;
}

export function requestDismiss(
  state: AskState,
  action: "dismiss" | "cancel",
  confirmDirty: boolean,
  editorDraft = "",
): boolean {
  if (!confirmDirty || !isDirty(state, editorDraft)) return true;
  if (state.dirtyDismiss === action) return true;
  state.dirtyDismiss = action;
  return false;
}

export function serializeAnswer(state: AskState, question: AskQuestion, includeUnselectedNotes = false): AskAnswer | undefined {
  const draft = state.answers.get(question.id);
  if (!draft) return undefined;
  const values: string[] = [];
  const labels: string[] = [];
  const indices: number[] = [];
  for (const [index, option] of question.options.entries()) {
    if (!draft.selected.has(option.value)) continue;
    values.push(option.value);
    labels.push(option.label);
    indices.push(index + 1);
  }
  if (draft.customSelected && draft.customText) {
    values.push(draft.customText);
    labels.push(draft.customText);
    indices.push(question.options.length + 1);
  }
  const optionNotes = safeRecord<string>();
  for (const [value, note] of draft.optionNotes) {
    if (includeUnselectedNotes || draft.selected.has(value)) optionNotes[value] = note;
  }
  if (!values.length && !draft.note && !Object.keys(optionNotes).length) return undefined;
  return {
    values,
    labels,
    indices,
    ...(draft.customSelected && draft.customText ? { customText: draft.customText } : {}),
    ...(draft.note ? { note: draft.note } : {}),
    ...(Object.keys(optionNotes).length ? { optionNotes } : {}),
  };
}

function currentQuestionMetadata(state: AskState, question: AskQuestion) {
  const current = presentedType(state, question);
  return {
    id: question.id,
    label: question.label,
    prompt: question.prompt,
    type: question.type,
    ...(current !== question.type ? { presentedType: current } : {}),
  };
}

function currentPublicQuestion(state: AskState, question: AskQuestion) {
  return { ...currentQuestionMetadata(state, question), options: question.options.map((option) => ({ ...option })) };
}

function formattedSelections(answer: AskAnswer): string[] {
  return answer.values.map((value, selectionIndex) => {
    const label = answer.labels[selectionIndex] ?? value;
    const index = answer.indices[selectionIndex];
    const custom = answer.customText !== undefined && selectionIndex === answer.values.length - 1
      && value === answer.customText && label === answer.customText;
    return `  selected: ${JSON.stringify(label)} (${custom ? "custom" : `value ${JSON.stringify(value)}`}, index ${index ?? "unknown"})`;
  });
}

/** Canonical text sent to the agent for tool results and command/recovery messages. */
export function formatAgentResultContent(details: AskResult["details"]): string {
  if (details.cancelled) return "User cancelled ask_user.";
  const lines = [details.mode === "elaborate" ? "User requested ask_user elaboration:" : "User submitted ask_user answers:"];
  for (const question of details.questions) {
    const answer = Object.hasOwn(details.answers, question.id) ? details.answers[question.id] : undefined;
    lines.push(`- [${question.id}] ${question.prompt}`);
    if (answer?.values.length) lines.push(...formattedSelections(answer));
    else lines.push("  selected: (none)");
    if (answer?.customText) lines.push(`  custom text: ${JSON.stringify(answer.customText)}`);
    if (answer?.note) lines.push(`  question note: ${JSON.stringify(answer.note)}`);
    for (const [value, note] of Object.entries(answer?.optionNotes ?? safeRecord<string>())) {
      const selection = answer?.values.indexOf(value) ?? -1;
      const index = selection >= 0 ? answer?.indices[selection] : undefined;
      lines.push(`  selected option note: value ${JSON.stringify(value)}${index ? `, index ${index}` : ""}: ${JSON.stringify(note)}`);
    }
  }
  if (details.mode === "elaborate") {
    for (const item of details.elaboration?.items ?? []) {
      if (item.target.kind === "question") {
        lines.push(`- clarify question [${item.question.id}]: ${JSON.stringify(item.note)}`);
      } else {
        const optionValue = item.target.optionValue;
        const optionIndex = item.question.options.findIndex((option) => option.value === optionValue) + 1;
        lines.push(`- clarify option on [${item.question.id}]: ${JSON.stringify(item.option?.label ?? optionValue)} (value ${JSON.stringify(optionValue)}${optionIndex > 0 ? `, index ${optionIndex}` : ""}): ${JSON.stringify(item.note)}`);
      }
    }
    if (!details.elaboration?.items.length) lines.push("- Clarify the committed choices before re-asking affected questions.");
  }
  if (details.questions.some((question) => {
    const answer = Object.hasOwn(details.answers, question.id) ? details.answers[question.id] : undefined;
    return Boolean(answer?.values.length && question.presentedType && question.presentedType !== question.type);
  })) {
    lines.push("Note: one or more answered questions used a different presentation type than requested.");
  }
  const text = lines.join("\n");
  const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - 512, maxLines: DEFAULT_MAX_LINES - 2 });
  if (!truncation.truncated) return text;
  return `${truncation.content}\n\n[Ask result truncated: ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full structured answers remain available in the tool result details.]`;
}

export function buildResult(state: AskState, mode: "submit" | "elaborate"): AskResult {
  const committed = safeRecord<AskAnswer>();
  for (const question of state.form.questions) {
    const answer = serializeAnswer(state, question);
    if (answer && answer.values.length > 0) committed[question.id] = answer;
    else if (mode === "submit" && answer) committed[question.id] = answer;
  }
  if (mode === "submit") {
    const result: AskResult = {
      content: [{ type: "text", text: "" }],
      details: {
        ...(state.form.title ? { title: state.form.title } : {}),
        cancelled: false,
        mode,
        questions: state.form.questions.map((question) => currentQuestionMetadata(state, question)),
        answers: committed,
      },
    };
    result.content[0].text = formatAgentResultContent(result.details);
    return result;
  }

  const items: ElaborationItem[] = [];
  const affected = new Set<string>();
  for (const question of state.form.questions) {
    const draft = state.answers.get(question.id);
    const answer = committed[question.id];
    if (draft?.note) {
      affected.add(question.id);
      items.push({
        target: { kind: "question" as const },
        question: currentPublicQuestion(state, question),
        answered: Boolean(answer?.values.length),
        ...(answer ? { answer } : {}),
        note: draft.note,
      });
    }
    for (const [value, note] of draft?.optionNotes ?? []) {
      const option = question.options.find((candidate) => candidate.value === value);
      if (!option) continue;
      affected.add(question.id);
      items.push({
        target: { kind: "option" as const, optionValue: value },
        question: currentPublicQuestion(state, question),
        option: { ...option },
        selected: draft?.selected.has(value) ?? false,
        answered: Boolean(answer?.values.length),
        ...(answer ? { answer } : {}),
        note,
      });
    }
  }
  if (affected.size === 0) {
    for (const question of state.form.questions) if (committed[question.id]) affected.add(question.id);
  }
  const affectedIds = [...affected];
  const questionStates = safeRecord<{ status: "answered" | "needs_clarification" | "unanswered" }>();
  for (const question of state.form.questions) {
    questionStates[question.id] = {
      status: affected.has(question.id) ? "needs_clarification" : committed[question.id] ? "answered" : "unanswered",
    };
  }
  const preservedAnswers = safeRecord<AskAnswer>();
  for (const [id, answer] of Object.entries(committed)) if (!affected.has(id)) preservedAnswers[id] = answer;
  const result: AskResult = {
    content: [{ type: "text", text: "" }],
    details: {
      ...(state.form.title ? { title: state.form.title } : {}),
      cancelled: false,
      mode,
      questions: state.form.questions.map((question) => currentQuestionMetadata(state, question)),
      answers: committed,
      continuation: {
        strategy: "refine_only",
        affectedQuestionIds: affectedIds,
        preservedAnswers,
        questionStates,
      },
      elaboration: {
        instruction: "Answer the user's clarification request directly first. Re-ask only affected questions if a choice is still needed, preferably as one structured ask with 2-3 related unresolved questions.",
        nextAction: "clarify_then_reask",
        items,
      },
    },
  };
  result.content[0].text = formatAgentResultContent(result.details);
  return result;
}

export function cancelledResult(form: AskForm, message = "User cancelled ask_user."): AskResult {
  return {
    content: [{ type: "text", text: message }],
    details: {
      ...(form.title ? { title: form.title } : {}),
      cancelled: true,
      mode: "submit",
      questions: form.questions.map(questionMetadata),
      answers: safeRecord<AskAnswer>(),
    },
  };
}

export interface RemoteAnswerInput {
  values?: string[];
  customText?: string;
  note?: string;
  optionNotes?: Record<string, string>;
}

export function applyRemoteAnswers(state: AskState, answers: Record<string, RemoteAnswerInput>): string | undefined {
  const knownIds = new Set(state.form.questions.map((question) => question.id));
  for (const id of Object.keys(answers)) if (!knownIds.has(id)) return `unknown question id ${JSON.stringify(id)}`;
  const replacement = new Map<string, DraftAnswer>();
  for (const question of state.form.questions) {
    if (!Object.hasOwn(answers, question.id)) continue;
    const input = answers[question.id];
    if (!input) continue;
    const knownValues = new Set(question.options.map((option) => option.value));
    for (const value of input.values ?? []) if (!knownValues.has(value)) return `unknown option value ${JSON.stringify(value)} for ${question.id}`;
    for (const value of Object.keys(input.optionNotes ?? safeRecord<string>())) if (!knownValues.has(value)) return `unknown option note value ${JSON.stringify(value)} for ${question.id}`;
    if (presentedType(state, question) !== "multi" && (input.values?.length ?? 0) + (input.customText && sanitizeText(input.customText).trim() ? 1 : 0) > 1) {
      return `single-select question ${question.id} accepts one answer`;
    }
    replacement.set(question.id, {
      selected: new Set(input.values ?? []),
      ...(input.customText && sanitizeText(input.customText).trim() ? { customText: sanitizeText(input.customText).trim() } : {}),
      customSelected: Boolean(input.customText && sanitizeText(input.customText).trim()),
      ...(input.note && sanitizeText(input.note).trim() ? { note: sanitizeText(input.note).trim() } : {}),
      optionNotes: new Map(Object.entries(input.optionNotes ?? safeRecord<string>())
        .map(([value, note]) => [value, sanitizeText(note).trim()] as const)
        .filter(([, note]) => note)),
    });
  }
  state.answers = replacement;
  return undefined;
}
