import test from "node:test";
import assert from "node:assert/strict";
import { extractAskForm, latestCompletedAssistant, parseExtractedAsk, selectExtractionModel } from "../src/extraction.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

const args = { questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] };

test("parses ask_user tool calls and tolerant fenced JSON", () => {
  const tool = parseExtractedAsk({ content: [{ type: "toolCall", id: "1", name: "ask_user", arguments: args }] } as any);
  assert.equal(tool.form?.questions[0]?.id, "q");
  const fenced = parseExtractedAsk(`words\n\`\`\`json\n${JSON.stringify(args)}\n\`\`\``);
  assert.equal(fenced.form?.questions[0]?.label, "Q1");
  assert.equal(parseExtractedAsk('{"questions":[]}').empty, true);
  assert.match(parseExtractedAsk("not json").error!, /neither/);
});

test("finds latest completed assistant and preceding user context", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "Need a choice" } },
    { type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "A or B?" }] } },
  ];
  assert.deepEqual(latestCompletedAssistant(branch).conversation, { assistantText: "A or B?", precedingUserText: "Need a choice" });
  assert.match(latestCompletedAssistant([{ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [] } }]).error!, /incomplete/);
});

test("model selection respects scope and auth then falls back to current", async () => {
  const configured = { provider: "openai-codex", id: "gpt-5.4-mini" } as any;
  const current = { provider: "anthropic", id: "current" } as any;
  const ctx: any = {
    model: current,
    scopedModels: [{ model: current }],
    modelRegistry: {
      find: () => configured,
      getApiKeyAndHeaders: async (model: any) => ({ ok: model === current }),
    },
  };
  assert.equal(await selectExtractionModel(ctx, DEFAULT_CONFIG), current);
});

test("model extraction requests one synthetic ask_user tool", async () => {
  const model = { provider: "p", id: "m" } as any;
  let context: any;
  const ctx: any = {
    model,
    scopedModels: [],
    modelRegistry: {
      find: () => undefined,
      getApiKeyAndHeaders: async () => ({ ok: true }),
      complete: async (_model: any, nextContext: any) => {
        context = nextContext;
        return { content: [{ type: "toolCall", id: "call", name: "ask_user", arguments: args }] };
      },
    },
  };
  const result = await extractAskForm(ctx, DEFAULT_CONFIG, { assistantText: "Q?" });
  assert.equal(result.form?.questions[0]?.id, "q");
  assert.equal(context.tools[0].name, "ask_user");
  assert.ok(context.tools[0].parameters.properties.questions);
});

test("retries invalid extraction and accepts open-ended internal form", async () => {
  const model = { provider: "p", id: "m" } as any;
  let attempts = 0;
  const ctx: any = {
    model,
    scopedModels: [],
    modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) },
  };
  const result = await extractAskForm(ctx, { ...structuredClone(DEFAULT_CONFIG), answer: { ...DEFAULT_CONFIG.answer, extractionRetries: 1 } }, { assistantText: "Explain?" }, undefined, {
    complete: async () => {
      attempts++;
      if (attempts === 1) return { content: [{ type: "text", text: "bad" }] } as any;
      return { content: [{ type: "text", text: '{"questions":[{"id":"open","prompt":"Explain?","freeform":true,"options":[]}]}' }] } as any;
    },
  });
  assert.equal(attempts, 2);
  assert.equal(result.form?.questions[0]?.freeform, true);
});

test("retry prompt includes bounded malformed response and validation error", async () => {
  const model = { provider: "p", id: "m" } as any;
  const prompts: string[] = [];
  const ctx: any = { model, scopedModels: [], modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) } };
  const result = await extractAskForm(ctx, { ...structuredClone(DEFAULT_CONFIG), answer: { ...DEFAULT_CONFIG.answer, extractionRetries: 1 } }, { assistantText: "Q?" }, undefined, {
    complete: async (_model, messages) => {
      prompts.push((messages[0]!.content[0] as any).text);
      if (prompts.length === 1) return { content: [{ type: "text", text: `not-json-${"x".repeat(10_000)}` }] } as any;
      return { content: [{ type: "toolCall", id: "ok", name: "ask_user", arguments: args }] } as any;
    },
  });
  assert.equal(result.form?.questions[0]?.id, "q");
  assert.match(prompts[1]!, /Previous malformed response \(bounded\):/);
  assert.match(prompts[1]!, /Validation error:/);
  assert.ok(prompts[1]!.length < 3_000);
});

test("external cancellation stops retries immediately", async () => {
  const model = { provider: "p", id: "m" } as any;
  const ctx: any = { model, scopedModels: [], modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) } };
  const controller = new AbortController();
  let attempts = 0;
  const result = await extractAskForm(ctx, { ...structuredClone(DEFAULT_CONFIG), answer: { ...DEFAULT_CONFIG.answer, extractionRetries: 3 } }, { assistantText: "Q?" }, controller.signal, {
    complete: async () => {
      attempts++;
      controller.abort(new Error("user cancelled"));
      throw new Error("aborted");
    },
  });
  assert.equal(attempts, 1);
  assert.match(result.error!, /user cancelled/);
});
