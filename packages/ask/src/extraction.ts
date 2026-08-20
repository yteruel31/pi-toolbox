import { StringEnum, type AssistantMessage, type Model, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AskConfig } from "./config.ts";
import { normalizeAsk, optionSchema, prepareAskArguments, type AskForm } from "./contracts.ts";

const extractionToolSchema = Type.Object({
  title: Type.Optional(Type.String()),
  questions: Type.Array(Type.Object({
    id: Type.String(),
    label: Type.Optional(Type.String()),
    prompt: Type.String(),
    type: Type.Optional(StringEnum(["single", "multi", "preview"] as const)),
    required: Type.Optional(Type.Boolean()),
    freeform: Type.Optional(Type.Boolean()),
    options: Type.Array(optionSchema),
  })),
});

const EXTRACTION_PROMPT = `Extract decision or clarification questions from the assistant response into one ask_user form.
Return exactly one ask_user tool call when tool calls are supported. A JSON object matching {"title"?:string,"questions": [...]} is an acceptable fallback.
Each question needs id, prompt, type (single, multi, or preview), and options with value and label. Preserve explicit choices. For a genuinely open-ended question with no choices, set "freeform": true and use an empty options array. Use preview only when every option has non-empty preview text.
If there are no questions, return {"questions":[]}.
Do not answer the questions yourself.`;

export interface ConversationForExtraction {
  assistantText: string;
  precedingUserText?: string;
}

interface BranchEntry { type?: string; message?: unknown }
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    const block = object(item);
    return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

export function latestCompletedAssistant(branch: readonly BranchEntry[]): { conversation?: ConversationForExtraction; error?: string } {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = object(entry.message);
    if (message?.role !== "assistant") continue;
    if (message.stopReason !== "stop") return { error: `Latest assistant message is incomplete (${String(message.stopReason)})` };
    const assistantText = textFromContent(message.content);
    if (!assistantText) return { error: "Latest assistant message has no text" };
    let precedingUserText: string | undefined;
    for (let before = index - 1; before >= 0; before--) {
      const previous = branch[before];
      if (previous?.type !== "message") continue;
      const previousMessage = object(previous.message);
      if (previousMessage?.role === "user") {
        precedingUserText = textFromContent(previousMessage.content);
        break;
      }
    }
    return { conversation: { assistantText, ...(precedingUserText ? { precedingUserText } : {}) } };
  }
  return { error: "No assistant message found on this branch" };
}

function inScope(model: Model<any>, ctx: Pick<ExtensionContext, "scopedModels">): boolean {
  return ctx.scopedModels.length === 0 || ctx.scopedModels.some((entry) => entry.model.provider === model.provider && entry.model.id === model.id);
}

export async function selectExtractionModel(
  ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels" | "model">,
  config: AskConfig,
): Promise<Model<any> | undefined> {
  const candidates = config.answer.extractionModels
    .map(({ provider, id }) => ctx.modelRegistry.find(provider, id))
    .filter((model): model is Model<any> => Boolean(model));
  if (ctx.model && !candidates.some((model) => model.provider === ctx.model!.provider && model.id === ctx.model!.id)) candidates.push(ctx.model);
  for (const model of candidates) {
    if (!inScope(model, ctx)) continue;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (auth.ok) return model;
    } catch {
      // Try the next configured model.
    }
  }
  return undefined;
}

function balancedObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

export function parseExtractedAsk(response: Pick<AssistantMessage, "content"> | string): { form?: AskForm; empty?: true; error?: string; raw?: unknown } {
  let raw: unknown;
  let text = "";
  if (typeof response !== "string") {
    for (const block of response.content) {
      if (block.type === "toolCall" && block.name === "ask_user") {
        raw = prepareAskArguments(block.arguments);
        break;
      }
      if (block.type === "text") text += `${block.text}\n`;
    }
  } else text = response;
  if (raw === undefined) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = fenced ?? balancedObject(text);
    if (!candidate) return { error: "extractor returned neither ask_user nor JSON" };
    try { raw = JSON.parse(candidate); }
    catch (error) { return { error: `extractor returned invalid JSON: ${(error as Error).message}` }; }
  }
  const root = object(raw);
  if (Array.isArray(root?.questions) && root.questions.length === 0) return { empty: true, raw };
  const normalized = normalizeAsk(prepareAskArguments(raw), { allowInternalFreeform: true });
  if (!normalized.form) return { error: normalized.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "), raw };
  return { form: normalized.form, raw };
}

export interface ExtractionAttemptDependencies {
  complete(model: Model<any>, messages: UserMessage[], signal: AbortSignal): Promise<AssistantMessage>;
}

const MAX_RETRY_RESPONSE_CHARS = 2_000;

function boundedMalformedResponse(response: AssistantMessage): string {
  let serialized: string;
  try { serialized = JSON.stringify(response.content); }
  catch { serialized = "[unserializable assistant response]"; }
  return serialized.length <= MAX_RETRY_RESPONSE_CHARS
    ? serialized
    : `${serialized.slice(0, MAX_RETRY_RESPONSE_CHARS)}…`;
}

function abortMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : "extraction cancelled";
}

export async function extractAskForm(
  ctx: Pick<ExtensionContext, "modelRegistry" | "scopedModels" | "model">,
  config: AskConfig,
  conversation: ConversationForExtraction,
  externalSignal?: AbortSignal,
  dependencies?: ExtractionAttemptDependencies,
): Promise<{ form?: AskForm; empty?: true; model?: Model<any>; error?: string }> {
  if (externalSignal?.aborted) return { error: abortMessage(externalSignal) };
  const model = await selectExtractionModel(ctx, config);
  if (externalSignal?.aborted) return { error: abortMessage(externalSignal), ...(model ? { model } : {}) };
  if (!model) return { error: "No authenticated extraction model is available in the current model scope" };
  let feedback = "";
  for (let attempt = 0; attempt <= config.answer.extractionRetries; attempt++) {
    if (externalSignal?.aborted) return { error: abortMessage(externalSignal), model };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("extraction timed out")), config.answer.extractionTimeoutMs);
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    const prompt = [
      conversation.precedingUserText ? `Preceding user message:\n${conversation.precedingUserText}` : undefined,
      `Assistant response to extract:\n${conversation.assistantText}`,
      feedback || undefined,
    ].filter(Boolean).join("\n\n");
    const messages: UserMessage[] = [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }];
    try {
      const response = dependencies
        ? await dependencies.complete(model, messages, signal)
        : await ctx.modelRegistry.complete(model, {
          systemPrompt: EXTRACTION_PROMPT,
          messages,
          tools: [{ name: "ask_user", description: "Return the extracted questions as one synthetic ask_user form", parameters: extractionToolSchema }],
        }, { signal });
      signal.throwIfAborted();
      const parsed = parseExtractedAsk(response);
      if (parsed.form) return { form: parsed.form, model };
      if (parsed.empty) return { empty: true, model };
      feedback = `Previous malformed response (bounded): ${boundedMalformedResponse(response)}\nValidation error: ${parsed.error}. Return one valid ask_user tool call or valid JSON.`;
    } catch (error) {
      if (externalSignal?.aborted) return { error: abortMessage(externalSignal), model };
      feedback = `Previous extraction attempt failed: ${(error as Error).message}. Try again with one valid ask_user form.`;
    } finally {
      clearTimeout(timeout);
    }
  }
  return { error: feedback, model };
}
