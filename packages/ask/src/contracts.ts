import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const ASK_EVENT_PREFIX = "@yteruel31/pi-ask";
export const CUSTOM_OPTION_VALUE = "__pi_ask_custom__";

export const optionSchema = Type.Object({
  value: Type.String({ description: "Stable value returned when selected" }),
  label: Type.String({ description: "Short option label" }),
  description: Type.Optional(Type.String({ description: "Optional explanation" })),
  preview: Type.Optional(Type.String({ description: "Required for every option in preview questions" })),
  recommended: Type.Optional(Type.Boolean({ description: "Presentation-only recommendation marker" })),
});

export const questionSchema = Type.Object({
  id: Type.String({ description: "Unique question identifier" }),
  label: Type.Optional(Type.String({ description: "Short tab label" })),
  prompt: Type.String({ description: "Question shown to the user" }),
  type: Type.Optional(StringEnum(["single", "multi", "preview"] as const)),
  required: Type.Optional(Type.Boolean({ description: "Advisory metadata; never blocks submission" })),
  options: Type.Array(optionSchema, { minItems: 1 }),
});

export const askParamsSchema = Type.Object({
  title: Type.Optional(Type.String()),
  questions: Type.Array(questionSchema, { minItems: 1 }),
});

export type PublicAskParams = Static<typeof askParamsSchema>;
export type AskType = "single" | "multi" | "preview";
export type AskSource = "tool" | "answer" | "answer:again" | "ask:replay" | "ask:resume";

export interface AskOption {
  value: string;
  label: string;
  description?: string;
  preview?: string;
  recommended?: boolean;
}

export interface AskQuestion {
  id: string;
  label: string;
  prompt: string;
  type: AskType;
  presentedType?: AskType;
  required: boolean;
  options: AskOption[];
  /** Internal marker used only by /answer extraction. */
  freeform?: boolean;
}

export interface AskForm {
  title?: string;
  questions: AskQuestion[];
}

export interface AskIssue {
  path: string;
  message: string;
}

export interface AskAnswer {
  values: string[];
  labels: string[];
  indices: number[];
  customText?: string;
  note?: string;
  optionNotes?: Record<string, string>;
}

export interface AskQuestionResult {
  id: string;
  label: string;
  prompt: string;
  type: AskType;
  presentedType?: AskType;
}

export interface ElaborationItem {
  target: { kind: "question" } | { kind: "option"; optionValue: string };
  question: AskQuestionResult & { options: AskOption[] };
  option?: AskOption;
  selected?: boolean;
  answered: boolean;
  answer?: AskAnswer;
  note: string;
}

export interface AskResultDetails {
  title?: string;
  cancelled: boolean;
  error?: { kind: "invalid_input"; issues: AskIssue[] };
  mode: "submit" | "elaborate";
  questions: AskQuestionResult[];
  answers: Record<string, AskAnswer>;
  continuation?: {
    strategy: "refine_only" | "resume";
    affectedQuestionIds: string[];
    preservedAnswers: Record<string, AskAnswer>;
    questionStates: Record<string, { status: "answered" | "needs_clarification" | "unanswered" }>;
  };
  elaboration?: {
    instruction: string;
    nextAction: "clarify" | "clarify_then_reask";
    items: ElaborationItem[];
  };
}

export interface AskResult {
  content: [{ type: "text"; text: string }];
  details: AskResultDetails;
}

export interface NormalizeOptions {
  presentSingleAsMulti?: boolean;
  allowInternalFreeform?: boolean;
}

/** Create a prototype-free dictionary for keys supplied by tools, users, or remote bridges. */
export function safeRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function sanitizeText(value: string): string {
  return value
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = sanitizeText(value).trim();
  return trimmed || undefined;
}

function titleFromValue(value: string): string {
  const spaced = value.replaceAll(/[-_]+/g, " ").trim();
  return spaced ? spaced[0]!.toUpperCase() + spaced.slice(1) : value;
}

/** Compatibility preparation runs before Pi validates the strict public schema. */
export function prepareAskArguments(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.questions)) return input;
  return {
    ...root,
    questions: root.questions.map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const question = raw as Record<string, unknown>;
      if (!Array.isArray(question.options)) return raw;
      return {
        ...question,
        options: question.options.map((candidate) => {
          if (!candidate || typeof candidate !== "object") return candidate;
          const option = candidate as Record<string, unknown>;
          const value = optionalText(option.value);
          if (optionalText(option.label) || !value) return candidate;
          return { ...option, label: titleFromValue(value) };
        }),
      };
    }),
  };
}

export function normalizeAsk(input: unknown, options: NormalizeOptions = {}): { form?: AskForm; issues: AskIssue[] } {
  const issues: AskIssue[] = [];
  if (!input || typeof input !== "object") return { issues: [{ path: "$", message: "must be an object" }] };
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.questions) || root.questions.length === 0) {
    return { issues: [{ path: "questions", message: "must contain at least one question" }] };
  }
  const ids = new Set<string>();
  const questions: AskQuestion[] = [];
  root.questions.forEach((raw, questionIndex) => {
    const path = `questions[${questionIndex}]`;
    if (!raw || typeof raw !== "object") {
      issues.push({ path, message: "must be an object" });
      return;
    }
    const candidate = raw as Record<string, unknown>;
    const id = optionalText(candidate.id);
    const prompt = optionalText(candidate.prompt);
    if (!id) issues.push({ path: `${path}.id`, message: "must be non-empty after trimming" });
    else if (ids.has(id)) issues.push({ path: `${path}.id`, message: `duplicate question id ${JSON.stringify(id)}` });
    else ids.add(id);
    if (!prompt) issues.push({ path: `${path}.prompt`, message: "must be non-empty after trimming" });
    const requested = candidate.type === undefined ? "single" : candidate.type;
    if (requested !== "single" && requested !== "multi" && requested !== "preview") {
      issues.push({ path: `${path}.type`, message: "must be single, multi, or preview" });
    }
    const freeform = options.allowInternalFreeform && candidate.freeform === true;
    if (!Array.isArray(candidate.options) || (candidate.options.length === 0 && !freeform)) {
      issues.push({ path: `${path}.options`, message: "must contain at least one option" });
      return;
    }
    const values = new Set<string>();
    const normalizedOptions: AskOption[] = [];
    for (const [optionIndex, rawOption] of (candidate.options as unknown[]).entries()) {
      const optionPath = `${path}.options[${optionIndex}]`;
      if (!rawOption || typeof rawOption !== "object") {
        issues.push({ path: optionPath, message: "must be an object" });
        continue;
      }
      const item = rawOption as Record<string, unknown>;
      const value = optionalText(item.value);
      const label = optionalText(item.label) ?? (value ? titleFromValue(value) : undefined);
      if (!value) issues.push({ path: `${optionPath}.value`, message: "must be non-empty after trimming" });
      else if (values.has(value)) issues.push({ path: `${optionPath}.value`, message: `duplicate option value ${JSON.stringify(value)}` });
      else values.add(value);
      if (!label) issues.push({ path: `${optionPath}.label`, message: "must be non-empty after trimming" });
      const preview = optionalText(item.preview);
      if (requested === "preview" && !preview) {
        issues.push({
          path: `${optionPath}.preview`,
          message: "preview questions need preview text for every option; add preview text or use type single",
        });
      }
      if (value && label) normalizedOptions.push({
        value,
        label,
        ...(optionalText(item.description) ? { description: optionalText(item.description) } : {}),
        ...(preview ? { preview } : {}),
        ...(item.recommended === true ? { recommended: true } : {}),
      });
    }
    if (!id || !prompt || (requested !== "single" && requested !== "multi" && requested !== "preview")) return;
    const presentedType = options.presentSingleAsMulti && requested === "single" ? "multi" : requested;
    questions.push({
      id,
      label: optionalText(candidate.label) ?? `Q${questionIndex + 1}`,
      prompt,
      type: requested,
      ...(presentedType !== requested ? { presentedType } : {}),
      required: candidate.required === true,
      options: normalizedOptions,
      ...(freeform ? { freeform: true } : {}),
    });
  });
  if (issues.length > 0) return { issues };
  return { form: { ...(optionalText(root.title) ? { title: optionalText(root.title) } : {}), questions }, issues };
}

export function publicQuestion(question: AskQuestion): AskQuestionResult & { options: AskOption[] } {
  return {
    id: question.id,
    label: question.label,
    prompt: question.prompt,
    type: question.type,
    ...(question.presentedType && question.presentedType !== question.type ? { presentedType: question.presentedType } : {}),
    options: question.options.map((option) => ({ ...option })),
  };
}

export function questionMetadata(question: AskQuestion): AskQuestionResult {
  const { options: _options, ...metadata } = publicQuestion(question);
  return metadata;
}

export function invalidAskResult(input: unknown, issues: AskIssue[]): AskResult {
  const normalized = normalizeAsk(input, { allowInternalFreeform: true });
  return {
    content: [{
      type: "text",
      text: `Invalid ask_user payload:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
    }],
    details: {
      cancelled: true,
      error: { kind: "invalid_input", issues },
      mode: "submit",
      questions: normalized.form?.questions.map(questionMetadata) ?? [],
      answers: safeRecord<AskAnswer>(),
    },
  };
}
