import { stripVTControlCharacters } from "node:util";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  CONFIG_DIR_NAME,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  getAgentDir,
  isEditToolResult,
  isWriteToolResult,
  truncateHead,
  truncateLine,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { formatDiagnosticCardForModel } from "./diagnostics.js";
import { LSP_ACTIONS, lspToolText, type LspToolInput } from "./operations.js";
import { normalizeToolPath } from "./paths.js";
import { renderDiagnosticCard, renderLspCall, renderLspResult } from "./render.js";
import { LspService } from "./service.js";
import type { DiagnosticCardData, LspToolDetails } from "./types.js";

const DIAGNOSTIC_ENTRY_TYPE = "pi-lsp-diagnostics-entry";
const DIAGNOSTIC_MESSAGE_TYPE = "pi-lsp-diagnostics-message";

const lspSchema = Type.Object(
  {
    action: StringEnum(LSP_ACTIONS),
    file: Type.Optional(Type.String({ description: "File path relative to the workspace" })),
    line: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line containing symbol" })),
    symbol: Type.Optional(Type.String({ description: "Exact symbol substring on line; append #N for occurrence N" })),
    query: Type.Optional(Type.String({ description: "Optional symbol-name filter" })),
    new_name: Type.Optional(Type.String({ description: "New symbol name for rename" })),
    apply: Type.Optional(Type.Boolean({ description: "Apply a rename; defaults to false for a safe preview" })),
    timeout: Type.Optional(Type.Integer({ minimum: 5, maximum: 300, description: "Request timeout in seconds (default 20)" })),
  },
  { additionalProperties: false },
);

type LspSchemaInput = Static<typeof lspSchema>;

type InlineOutcome<T> = { kind: "value"; value: T } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error" };

function raceInline<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<InlineOutcome<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: InlineOutcome<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    const onAbort = () => finish({ kind: "aborted" });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    promise.then((value) => finish({ kind: "value", value }), () => finish({ kind: "error" }));
  });
}

function boundedToolResult(details: LspToolDetails): { text: string; details: LspToolDetails } {
  const clean = (value: string) => stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  const summary = truncateLine(clean(details.summary), 1_000).text;
  const candidate: LspToolDetails = {
    ...details,
    summary,
    lines: details.lines.slice(0, DEFAULT_MAX_LINES).map(clean),
  };
  const truncated = truncateHead(lspToolText(candidate), { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
  const outputLines = truncated.content.split("\n");
  if (outputLines[0] === summary) outputLines.shift();
  if (truncated.truncated) outputLines.push("... output truncated at Pi's tool output limit");
  return {
    text: truncated.truncated ? `${truncated.content}\n\n[Output truncated at Pi's tool output limit.]` : truncated.content,
    details: { ...candidate, lines: outputLines },
  };
}

async function createService(ctx: ExtensionContext): Promise<LspService> {
  const service = new LspService({
    cwd: ctx.cwd,
    agentDir: getAgentDir(),
    configDirName: CONFIG_DIR_NAME,
    projectTrusted: ctx.isProjectTrusted(),
  });
  await service.initialize();
  return service;
}

export default function lspExtension(pi: ExtensionAPI): void {
  let service: LspService | undefined;
  const pendingCards = new Map<string, DiagnosticCardData>();

  pi.registerEntryRenderer<DiagnosticCardData>(DIAGNOSTIC_ENTRY_TYPE, (entry, { expanded }, theme) =>
    renderDiagnosticCard(entry.data ?? {
      file: "unknown",
      server: "unknown",
      delayed: false,
      cleared: false,
      counts: { errors: 0, warnings: 0, information: 0, hints: 0 },
      diagnostics: [],
      omitted: 0,
    }, expanded, theme),
  );
  pi.registerMessageRenderer(DIAGNOSTIC_MESSAGE_TYPE, (message, { expanded, outputPad }, theme) =>
    renderDiagnosticCard(message.details as DiagnosticCardData, expanded, theme, outputPad),
  );

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description:
      "Use project language servers for fresh diagnostics and symbol-aware navigation or rename. Actions: diagnostics, definition, references, hover, symbols, rename, status, reload. Position actions use file + 1-indexed line + symbol substring. Rename previews by default; set apply=true to mutate files. Output is truncated to Pi's 50KB/2000-line limit.",
    promptSnippet: "Query language servers for diagnostics, navigation, symbols, and safe semantic rename previews",
    promptGuidelines: [
      "Use lsp definition, references, hover, and symbols for symbol-aware code navigation when a language server is available.",
      "Use lsp rename instead of text replacement for cross-file symbol renames; preview first, then apply only when the requested rename is clear.",
    ],
    parameters: lspSchema,
    async execute(_toolCallId, params: LspSchemaInput, signal, onUpdate, ctx) {
      if (!service || service.cwd !== ctx.cwd) {
        await service?.shutdown();
        service = await createService(ctx);
      }
      onUpdate?.({ content: [{ type: "text", text: `LSP ${params.action}…` }], details: undefined });
      const details = await service.execute(params as LspToolInput, signal);
      const bounded = boundedToolResult(details);
      return { content: [{ type: "text", text: bounded.text }], details: bounded.details };
    },
    renderCall(args, theme) {
      return renderLspCall(args, theme);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const content = result.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      return renderLspResult(result.details as LspToolDetails | undefined, content, expanded, isPartial, theme);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await service?.shutdown();
    service = await createService(ctx);
    pendingCards.clear();
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || (!isWriteToolResult(event) && !isEditToolResult(event))) return;
    if (!service || service.cwd !== ctx.cwd || !service.config.diagnostics.enabled) return;

    const inputPath = event.input.path;
    if (typeof inputPath !== "string") return;
    let filePath: string;
    try {
      filePath = normalizeToolPath(ctx.cwd, inputPath);
    } catch {
      return;
    }

    const activeService = service;
    const mutation = activeService.beginMutation(filePath);
    const pending = activeService.diagnosticsAfterMutation(filePath, ctx.signal);
    const outcome = await raceInline(pending, activeService.config.diagnostics.inlineTimeoutMs, ctx.signal);

    if (outcome.kind === "aborted") {
      activeService.invalidateMutation(filePath, mutation);
      return;
    }
    if (outcome.kind === "value") {
      if (!outcome.value || !activeService.isCurrentMutation(filePath, mutation)) return;
      const card = activeService.makeDiagnosticCard(filePath, outcome.value, false);
      if (!card) return;
      pendingCards.set(event.toolCallId, card);
      return {
        content: [...event.content, { type: "text" as const, text: formatDiagnosticCardForModel(card) }],
      };
    }
    if (outcome.kind === "error") return;

    void pending.then((result) => {
      if (!result || service !== activeService || !activeService.isCurrentMutation(filePath, mutation)) return;
      const card = activeService.makeDiagnosticCard(filePath, result, true);
      if (!card) return;
      pi.sendMessage(
        {
          customType: DIAGNOSTIC_MESSAGE_TYPE,
          content: formatDiagnosticCardForModel(card),
          display: true,
          details: card,
        },
        { deliverAs: "steer" },
      );
    }).catch(() => undefined);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "toolResult") return;
    const card = pendingCards.get(event.message.toolCallId);
    if (!card) return;
    pendingCards.delete(event.message.toolCallId);
    if (ctx.mode === "tui") pi.appendEntry(DIAGNOSTIC_ENTRY_TYPE, card);
  });

  pi.on("session_shutdown", async () => {
    pendingCards.clear();
    const active = service;
    service = undefined;
    await active?.shutdown();
  });
}

export { DiagnosticLedger, MutationVersions } from "./diagnostics.js";
export { MessageFramer, encodeMessage } from "./protocol.js";
export { applyWorkspaceEdit, formatWorkspaceEditPlan, planWorkspaceEdit } from "./workspace-edit.js";
export { loadConfig } from "./config.js";
export type { DiagnosticCardData, LspConfig, ServerDefinition, WorkspaceEdit } from "./types.js";
