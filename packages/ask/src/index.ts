import { BorderedLoader, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ConfigStore } from "./config.ts";
import {
  askParamsSchema,
  invalidAskResult,
  normalizeAsk,
  prepareAskArguments,
  questionMetadata,
  safeRecord,
  type AskAnswer,
  type AskForm,
  type AskResult,
  type AskSource,
  type PublicAskParams,
} from "./contracts.ts";
import { cancelledResult, formatAgentResultContent } from "./domain.ts";
import { extractAskForm, latestCompletedAssistant } from "./extraction.ts";
import { HerdrAttention } from "./herdr.ts";
import { DISMISSED_ENTRY, findPendingAsk, latestPayload, makePayload, PAYLOAD_ENTRY } from "./persistence.ts";
import { formatCallTranscript, formatResultTranscript } from "./render.ts";
import { RemoteAskRegistry } from "./remote.ts";
import { showAskFlow, showAskSettings } from "./surface.ts";

function nonTuiResult(form: AskForm): AskResult {
  const pending = form.questions.flatMap((question) => [
    `${question.label}: ${question.prompt}`,
    ...question.options.map((option, index) => `  ${index + 1}. ${option.label} (${option.value})`),
  ]);
  return {
    content: [{ type: "text", text: ["Needs user input: ask_user requires interactive TUI mode.", ...pending].join("\n") }],
    details: {
      ...(form.title ? { title: form.title } : {}),
      cancelled: true,
      mode: "submit",
      questions: form.questions.map(questionMetadata),
      answers: safeRecord<AskAnswer>(),
    },
  };
}

function agentMessage(result: AskResult): string {
  return formatAgentResultContent(result.details);
}

export function recoverAskForm(persisted: unknown | undefined, original: unknown, presentSingleAsMulti = false) {
  const normalize = (candidate: unknown) => normalizeAsk(prepareAskArguments(candidate), {
    allowInternalFreeform: true,
    presentSingleAsMulti,
  });
  const fromPersisted = persisted === undefined ? undefined : normalize(persisted);
  if (fromPersisted?.form) return { form: fromPersisted.form, source: "persisted" as const, issues: [] };
  const fromOriginal = normalize(original);
  if (fromOriginal.form) return { form: fromOriginal.form, source: "original" as const, issues: fromPersisted?.issues ?? [] };
  return { source: "invalid" as const, issues: [...(fromPersisted?.issues ?? []), ...fromOriginal.issues] };
}

export default function askExtension(pi: ExtensionAPI): void {
  const store = new ConfigStore();
  const remote = new RemoteAskRegistry(pi.events);
  const attention = new HerdrAttention(pi.events);

  async function openCommandForm(
    ctx: ExtensionCommandContext | ExtensionContext,
    formInput: unknown,
    source: AskSource,
  ): Promise<AskResult | undefined> {
    const normalized = normalizeAsk(prepareAskArguments(formInput), {
      allowInternalFreeform: true,
      presentSingleAsMulti: store.get().behaviour.presentSingleAsMulti,
    });
    if (!normalized.form) {
      ctx.ui.notify(`Stored ask form is invalid: ${normalized.issues[0]?.message ?? "unknown error"}`, "error");
      return undefined;
    }
    pi.appendEntry(PAYLOAD_ENTRY, makePayload(source, formInput));
    return showAskFlow(ctx, normalized.form, store, { source, remote, attention });
  }

  async function replay(ctx: ExtensionCommandContext, sources: AskSource[], source: AskSource): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`${source} requires interactive TUI mode`, "error");
      return;
    }
    const payload = latestPayload(ctx.sessionManager.getBranch(), sources);
    if (!payload) {
      ctx.ui.notify("No matching ask form exists on the current branch.", "warning");
      return;
    }
    const result = await openCommandForm(ctx, payload.params, source);
    if (result && !result.details.cancelled) pi.sendUserMessage(agentMessage(result));
  }

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description: "Ask one or more structured clarification questions. Supports single-select, multi-select, previews, free-form answers, and notes. Use when user input materially changes the next step.",
    promptSnippet: "Ask structured clarification or decision questions instead of guessing",
    promptGuidelines: [
      "Use ask_user when requirements, preferences, research scope, or a consequential decision remain unresolved; do not guess.",
      "Keep ask_user options distinct and outcome-oriented, and use recommended only as presentation metadata.",
    ],
    parameters: askParamsSchema,
    prepareArguments: (input) => prepareAskArguments(input) as PublicAskParams,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const normalized = normalizeAsk(params, { presentSingleAsMulti: store.get().behaviour.presentSingleAsMulti });
      if (!normalized.form) return invalidAskResult(params, normalized.issues);
      pi.appendEntry(PAYLOAD_ENTRY, makePayload("tool", params, toolCallId));
      if (ctx.mode !== "tui") return nonTuiResult(normalized.form);
      return showAskFlow(ctx, normalized.form, store, { source: "tool", toolCallId, signal, remote, attention });
    },
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold(formatCallTranscript(args))), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as AskResult["details"] | undefined;
      if (!details) {
        const content = result.content.find((item) => item.type === "text");
        return new Text(content?.type === "text" ? content.text : "", 0, 0);
      }
      const lines = formatResultTranscript(details).map((line) => {
        const color = line.startsWith("✓") ? "success" : line.startsWith("↻") ? "accent" : line === "Cancelled" ? "warning" : line === "Invalid tool payload" ? "error" : "muted";
        return theme.fg(color, line);
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerCommand("ask-settings", {
    description: "Open @yteruel31/pi-ask settings",
    handler: async (_args, ctx) => showAskSettings(ctx, store),
  });

  pi.registerCommand("answer", {
    description: "Extract the latest assistant questions into an ask form",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/answer requires interactive TUI mode", "error");
        return;
      }
      const latest = latestCompletedAssistant(ctx.sessionManager.getBranch());
      if (!latest.conversation) {
        ctx.ui.notify(latest.error ?? "No completed assistant response found", "error");
        return;
      }
      const extraction = await ctx.ui.custom<Awaited<ReturnType<typeof extractAskForm>> | null>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, "Extracting questions for /answer...");
        loader.onAbort = () => done(null);
        void extractAskForm(ctx, store.get(), latest.conversation!, loader.signal).then(done).catch((error) => done({ error: (error as Error).message }));
        return loader;
      });
      if (!extraction) {
        ctx.ui.notify("Question extraction cancelled.", "info");
        return;
      }
      if (extraction.error) {
        ctx.ui.notify(`Could not extract questions: ${extraction.error}`, "error");
        return;
      }
      if (extraction.empty || !extraction.form) {
        ctx.ui.notify("No questions found in the latest assistant response.", "info");
        return;
      }
      const result = await openCommandForm(ctx, extraction.form, "answer");
      if (result && !result.details.cancelled) pi.sendUserMessage(agentMessage(result));
    },
  });

  pi.registerCommand("answer:again", {
    description: "Replay the latest /answer form on this branch",
    handler: async (_args, ctx) => replay(ctx, ["answer", "answer:again"], "answer:again"),
  });

  pi.registerCommand("ask:replay", {
    description: "Replay the latest ask_user form on this branch",
    handler: async (_args, ctx) => replay(ctx, ["tool"], "ask:replay"),
  });

  pi.on("session_start", async (event, ctx) => {
    await store.load();
    for (const notice of store.notices) ctx.ui.notify(notice.message, notice.kind === "error" ? "error" : "warning");
    if (ctx.mode !== "tui" || !["startup", "resume", "fork"].includes(event.reason)) return;
    const pending = findPendingAsk(ctx.sessionManager.getBranch());
    if (!pending) return;
    queueMicrotask(() => void (async () => {
      const recovered = recoverAskForm(pending.payload?.params, pending.arguments, store.get().behaviour.presentSingleAsMulti);
      if (!recovered.form) {
        pi.appendEntry(DISMISSED_ENTRY, { version: 1, toolCallId: pending.toolCallId, reason: "invalid_payload", dismissedAt: Date.now() });
        ctx.ui.notify("An interrupted ask_user form could not be recovered because both persisted and original payloads are invalid.", "error");
        return;
      }
      let result: AskResult;
      try {
        result = await showAskFlow(ctx, recovered.form, store, {
          source: "ask:resume",
          toolCallId: pending.toolCallId,
          remote,
          attention,
        });
      } catch {
        result = cancelledResult(recovered.form, "Interrupted ask_user recovery closed.");
      }
      pi.appendEntry(DISMISSED_ENTRY, { version: 1, toolCallId: pending.toolCallId, dismissedAt: Date.now() });
      if (!result.details.cancelled) pi.sendUserMessage(agentMessage(result));
    })());
  });

  pi.on("session_shutdown", () => {
    attention.clear();
    remote.dispose();
  });
}

export {
  ConfigStore,
  extractAskForm,
  findPendingAsk,
  formatCallTranscript,
  formatResultTranscript,
  latestCompletedAssistant,
  latestPayload,
  normalizeAsk,
  prepareAskArguments,
};
