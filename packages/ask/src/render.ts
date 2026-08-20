import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { AskConfig } from "./config.ts";
import { activeQuestion, isAnswered, presentedType, serializeAnswer, type AskState } from "./domain.ts";

export interface AskRenderView {
  mode: "main" | "custom" | "question-note" | "option-note" | "settings";
  editorLines?: string[];
  editorTargetValue?: string;
  editorHint?: string;
  warning?: string;
  settingsCursor?: number;
  settingsMessage?: string;
  resetArmed?: boolean;
  scrollOffset?: number;
  maxHeight?: number;
  configPath: string;
}

function fit(line: string, width: number): string {
  return truncateToWidth(line, Math.max(1, width), "");
}

function addWrapped(lines: string[], text: string, width: number, prefix = ""): void {
  const safeWidth = Math.max(1, width);
  const prefixWidth = visibleWidth(prefix);
  const available = Math.max(1, safeWidth - prefixWidth);
  const wrapped = wrapTextWithAnsi(text, available);
  for (const [index, line] of wrapped.entries()) {
    lines.push(fit(`${index ? " ".repeat(prefixWidth) : prefix}${line}`, safeWidth));
  }
}

function keyLabel(key: string): string {
  const aliases: Record<string, string> = {
    enter: "Enter", esc: "Esc", tab: "Tab", space: "Space", up: "↑", down: "↓", left: "←", right: "→",
  };
  return key.split("+").map((part) => aliases[part] ?? (part === "ctrl" ? "Ctrl" : part === "shift" ? "Shift" : part === "alt" ? "Alt" : part.length === 1 ? part.toUpperCase() : part)).join("+");
}

function firstBinding(bindings: string[]): string {
  return keyLabel(bindings[0] ?? "");
}

export function editorBindingHint(config: AskConfig, kind: "submit" | "save"): string {
  if (kind === "submit") return `${firstBinding(config.keymaps.editor.submit)} submit · ${firstBinding(config.keymaps.editor.close)} close`;
  return `${firstBinding(config.keymaps.noteEditor.save)} save · ${firstBinding(config.keymaps.noteEditor.close)} close`;
}

function tabHint(config: AskConfig): string {
  const next = config.keymaps.main.nextTab;
  const previous = config.keymaps.main.previousTab;
  const defaults = next.includes("tab") && next.includes("right") && previous.includes("shift+tab") && previous.includes("left");
  return defaults ? "⇆ tab" : `${firstBinding(previous)}/${firstBinding(next)} tab`;
}

function mainFooter(state: AskState, config: AskConfig): string {
  if (state.tab === state.form.questions.length) {
    return `${tabHint(config)} · ${firstBinding(config.keymaps.main.previousOption)}/${firstBinding(config.keymaps.main.nextOption)} select · ${firstBinding(config.keymaps.main.confirm)} confirm · ${firstBinding(config.keymaps.main.cancel)} cancel`;
  }
  const question = activeQuestion(state);
  const pieces = [
    tabHint(config),
    `${firstBinding(config.keymaps.main.previousOption)}/${firstBinding(config.keymaps.main.nextOption)} select`,
    "Shift+↑/↓ scroll",
  ];
  if (question && presentedType(state, question) === "multi") pieces.push(`${firstBinding(config.keymaps.main.toggle)} toggle`);
  pieces.push(`${firstBinding(config.keymaps.main.confirm)} confirm`);
  pieces.push(`${firstBinding(config.keymaps.main.optionNote)}/${firstBinding(config.keymaps.main.questionNote)} note`);
  pieces.push(`${firstBinding(config.keymaps.main.changeQuestionType)} type`);
  pieces.push(`${firstBinding(config.keymaps.global.settings)} settings`);
  pieces.push(`${firstBinding(config.keymaps.global.dismiss)} dismiss`);
  return pieces.join(" · ");
}

function divider(theme: Theme, width: number): string {
  return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

function renderTabs(state: AskState, theme: Theme, width: number): string[] {
  const parts = [theme.fg("dim", "←")];
  for (const [index, question] of state.form.questions.entries()) {
    const answered = isAnswered(state, question);
    const label = ` ${answered ? "+" : "-"} ${question.label} `;
    parts.push(index === state.tab
      ? theme.bg("selectedBg", theme.fg("text", label))
      : theme.fg(answered ? "success" : "muted", label));
  }
  const review = state.tab === state.form.questions.length;
  const submit = " * Submit ";
  parts.push(review ? theme.bg("selectedBg", theme.fg("text", submit)) : theme.fg("success", submit));
  parts.push(theme.fg("dim", "→"));
  const lines: string[] = [];
  addWrapped(lines, parts.join("  "), width);
  return lines;
}

function optionSubtitle(theme: Theme, recommended: boolean | undefined, description: string | undefined): string | undefined {
  if (recommended) {
    const marker = theme.fg("warning", "(recommended)");
    return description ? `${marker}${theme.fg("muted", ` | ${description}`)}` : marker;
  }
  return description ? theme.fg("muted", description) : undefined;
}

function previewListWidth(width: number): number {
  return Math.max(28, Math.floor(width * 0.34));
}

export function inlineEditorWidth(state: AskState, width: number, mode: AskRenderView["mode"]): number {
  const safeWidth = Math.max(1, width);
  const question = activeQuestion(state);
  if (!question || question.freeform || mode === "question-note") return safeWidth;
  const listWidth = presentedType(state, question) === "preview" && safeWidth >= 72 ? previewListWidth(safeWidth) : safeWidth;
  return Math.max(1, listWidth - 5);
}

function borderedPreview(theme: Theme, option: { label: string; description?: string; preview?: string }, width: number): string[] {
  const safeWidth = Math.max(1, width);
  if (safeWidth === 1) return [theme.fg("borderAccent", "□")];
  if (safeWidth === 2) return [theme.fg("borderAccent", "┌┐"), theme.fg("borderAccent", "└┘")];
  const innerWidth = safeWidth - 2;
  const content: string[] = [];
  addWrapped(content, theme.fg("accent", option.label), innerWidth);
  if (option.description) addWrapped(content, theme.fg("muted", option.description), innerWidth);
  content.push("");
  addWrapped(content, option.preview ?? "", innerWidth);
  const horizontal = "─".repeat(Math.max(0, safeWidth - 2));
  const lines = [theme.fg("borderAccent", `┌${horizontal}┐`)];
  for (const line of content) {
    const clipped = fit(line, innerWidth);
    lines.push(`${theme.fg("borderAccent", "│")}${clipped}${" ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)))}${theme.fg("borderAccent", "│")}`);
  }
  lines.push(theme.fg("borderAccent", `└${horizontal}┘`));
  return lines.map((line) => fit(line, safeWidth));
}

function renderQuestion(state: AskState, theme: Theme, width: number, view: AskRenderView): string[] {
  const question = activeQuestion(state)!;
  const draft = state.answers.get(question.id);
  const type = presentedType(state, question);
  const lines: string[] = [];
  addWrapped(lines, theme.fg("text", theme.bold(question.prompt)), width);
  if (draft?.note && view.mode !== "question-note") addWrapped(lines, `${theme.fg("warning", "Note:")} ${theme.fg("muted", draft.note)}`, width);
  if (view.mode === "question-note") {
    for (const line of view.editorLines ?? []) lines.push(fit(line, width));
    lines.push(fit(theme.fg("dim", view.editorHint ?? ""), width));
  }
  lines.push("");

  if (question.freeform) {
    lines.push(fit(theme.fg("muted", "Type your answer:"), width));
    if (view.mode === "custom") {
      for (const line of view.editorLines ?? []) lines.push(fit(line, width));
      lines.push(fit(theme.fg("dim", view.editorHint ?? ""), width));
    } else if (draft?.customText) {
      addWrapped(lines, theme.fg("success", draft.customText), width);
    }
    return lines;
  }

  const widePreview = type === "preview" && width >= 72;
  const listWidth = widePreview ? previewListWidth(width) : width;
  const optionLines: string[] = [];
  for (const [index, option] of question.options.entries()) {
    const focused = state.cursor === index;
    const selected = draft?.selected.has(option.value) ?? false;
    const check = type === "multi" ? `[${selected ? "x" : " "}] ` : "";
    const caret = focused ? theme.fg("accent", "❯ ") : "  ";
    const labelColor = focused ? "accent" : selected ? "success" : "text";
    addWrapped(optionLines, theme.fg(labelColor, `${index + 1}. ${check}${option.label}`), listWidth, caret);
    const subtitle = optionSubtitle(theme, option.recommended, option.description);
    if (subtitle) addWrapped(optionLines, subtitle, listWidth, "     ");
    const optionNote = draft?.optionNotes.get(option.value);
    if (optionNote && !(view.mode === "option-note" && view.editorTargetValue === option.value)) {
      addWrapped(optionLines, `${theme.fg("warning", "Note:")} ${theme.fg("muted", optionNote)}`, listWidth, "     ");
    }
    if (view.mode === "option-note" && view.editorTargetValue === option.value) {
      for (const line of view.editorLines ?? []) optionLines.push(fit(`     ${line}`, listWidth));
      optionLines.push(fit(`     ${theme.fg("dim", view.editorHint ?? "")}`, listWidth));
    }
  }
  const customIndex = question.options.length;
  const customFocused = state.cursor === customIndex;
  const customSelected = draft?.customSelected ?? false;
  const customCheck = type === "multi" ? `[${customSelected ? "x" : " "}] ` : "";
  addWrapped(optionLines, theme.fg(customFocused ? "accent" : customSelected ? "success" : "text", `${customIndex + 1}. ${customCheck}Type your own`), listWidth, customFocused ? theme.fg("accent", "❯ ") : "  ");
  if (draft?.customText && view.mode !== "custom") addWrapped(optionLines, theme.fg("muted", draft.customText), listWidth, "     ");
  if (view.mode === "custom") {
    for (const line of view.editorLines ?? []) optionLines.push(fit(`     ${line}`, listWidth));
    optionLines.push(fit(`     ${theme.fg("dim", view.editorHint ?? "")}`, listWidth));
  }

  const selectedOption = state.cursor < question.options.length ? question.options[state.cursor] : undefined;
  if (type !== "preview") return [...lines, ...optionLines];
  if (!widePreview) {
    lines.push(...optionLines);
    if (selectedOption) lines.push("", ...borderedPreview(theme, selectedOption, width));
    return lines;
  }

  const gap = 3;
  const rightWidth = Math.max(1, width - listWidth - gap);
  const previewLines = selectedOption ? borderedPreview(theme, selectedOption, rightWidth) : [];
  const count = Math.max(optionLines.length, previewLines.length);
  for (let index = 0; index < count; index++) {
    const left = fit(optionLines[index] ?? "", listWidth);
    const padding = " ".repeat(Math.max(0, listWidth - visibleWidth(left)));
    lines.push(fit(`${left}${padding}${" ".repeat(gap)}${previewLines[index] ?? ""}`, width));
  }
  return lines;
}

function renderReview(state: AskState, theme: Theme, width: number): string[] {
  const lines: string[] = [theme.fg("accent", "Review answers"), ""];
  const elaborate = state.reviewCursor === 1;
  for (const question of state.form.questions) {
    const answer = serializeAnswer(state, question);
    const draft = state.answers.get(question.id);
    const answered = Boolean(answer?.values.length);
    lines.push(fit(theme.fg("text", question.label), width));
    if (draft?.note && (answered || elaborate)) addWrapped(lines, `${theme.fg("warning", "  Note:")} ${theme.fg("muted", draft.note)}`, width);
    if (answered) {
      for (const [selection, label] of answer!.labels.entries()) {
        const value = answer!.values[selection];
        const optionIndex = answer!.indices[selection];
        const declared = optionIndex !== undefined && optionIndex <= question.options.length
          && question.options[optionIndex - 1]?.value === value
          ? question.options[optionIndex - 1]
          : undefined;
        addWrapped(lines, theme.fg("success", `  → ${label}`), width);
        const note = declared ? draft?.optionNotes.get(declared.value) : undefined;
        if (note) addWrapped(lines, `${theme.fg("warning", "    Note:")} ${theme.fg("muted", note)}`, width);
      }
    } else addWrapped(lines, theme.fg("dim", "  → unanswered"), width);
    if (elaborate) {
      for (const [value, note] of draft?.optionNotes ?? []) {
        if (draft?.selected.has(value)) continue;
        const option = question.options.find((candidate) => candidate.value === value);
        if (option) addWrapped(lines, `${theme.fg("warning", `  ${option.label} Note:`)} ${theme.fg("muted", note)}`, width);
      }
    }
    lines.push("");
  }
  const actions = ["Submit", "Elaborate", "Cancel"];
  for (const [index, action] of actions.entries()) {
    const prefix = index === state.reviewCursor ? theme.fg("accent", "❯ ") : "  ";
    const pending = state.pendingReviewShortcut === index ? " (press again)" : "";
    lines.push(fit(`${prefix}${theme.fg(index === state.reviewCursor ? "accent" : "text", `${index + 1}. ${action}${pending}`)}`, width));
  }
  return lines;
}

export const SETTINGS_ROWS = [
  ["autoSubmitWhenAnsweredWithoutNotes", "Auto-submit when answered without notes"],
  ["confirmDismissWhenDirty", "Confirm dismiss when dirty"],
  ["doublePressReviewShortcuts", "Double-press review shortcuts"],
  ["presentSingleAsMulti", "Present single-select as multi-select"],
  ["showFooterHints", "Show footer hints"],
  ["notifications.enabled", "Notifications"],
  ["reset", "Reset configuration to defaults"],
] as const;

function renderSettings(config: AskConfig, theme: Theme, width: number, view: AskRenderView): string[] {
  const lines = [theme.fg("accent", theme.bold("Ask settings · @yteruel31/pi-ask")), theme.fg("dim", view.configPath), ""];
  SETTINGS_ROWS.forEach(([key, label], index) => {
    const focused = view.settingsCursor === index;
    const enabled = key === "notifications.enabled" ? config.notifications.enabled
      : key === "reset" ? undefined
      : config.behaviour[key as keyof AskConfig["behaviour"]];
    const value = key === "reset" ? (view.resetArmed ? "press again" : "action") : enabled ? "on" : "off";
    lines.push(fit(`${focused ? theme.fg("accent", "❯ ") : "  "}${theme.fg(focused ? "accent" : "text", label)} ${theme.fg(value === "on" ? "success" : value === "off" ? "muted" : "warning", `[${value}]`)}`, width));
  });
  if (view.settingsMessage) lines.push("", fit(theme.fg("warning", view.settingsMessage), width));
  lines.push("", fit(theme.fg("dim", `${firstBinding(config.keymaps.settingsModal.previousOption)}/${firstBinding(config.keymaps.settingsModal.nextOption)} select · ${firstBinding(config.keymaps.settingsModal.toggle)} toggle · ${firstBinding(config.keymaps.settingsModal.close)} close`), width));
  return lines;
}

function viewport(lines: string[], theme: Theme, width: number, maxHeight: number, requestedOffset: number, footerLines: number): string[] {
  if (lines.length <= maxHeight || maxHeight < 8) return lines;
  const header = lines.slice(0, 4);
  const footer = lines.slice(-footerLines);
  const body = lines.slice(4, -footerLines);
  const available = Math.max(1, maxHeight - header.length - footer.length);
  const maxOffset = Math.max(0, body.length - available + 1);
  const offset = Math.max(0, Math.min(requestedOffset, maxOffset));
  const hiddenAbove = offset > 0;
  const contentHeight = Math.max(1, available - (hiddenAbove ? 1 : 0));
  const hiddenBelow = offset + contentHeight < body.length;
  const sliceHeight = Math.max(1, contentHeight - (hiddenBelow ? 1 : 0));
  const visible = body.slice(offset, offset + sliceHeight);
  if (hiddenAbove) visible.unshift(fit(theme.fg("dim", `↑ ${offset} more line${offset === 1 ? "" : "s"} · Shift+↑`), width));
  if (hiddenBelow) {
    const remaining = body.length - offset - sliceHeight;
    visible.push(fit(theme.fg("dim", `↓ ${remaining} more line${remaining === 1 ? "" : "s"} · Shift+↓`), width));
  }
  return [...header, ...visible, ...footer];
}

export function renderAsk(state: AskState, config: AskConfig, theme: Theme, width: number, view: AskRenderView): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  if (view.mode === "settings") lines.push(...renderSettings(config, theme, safeWidth, view));
  else {
    const header = state.form.title ? `${state.form.title} (ask_user)` : "ask_user";
    lines.push(theme.fg("accent", theme.bold(header)));
    lines.push(divider(theme, safeWidth));
    lines.push(...renderTabs(state, theme, safeWidth));
    lines.push(divider(theme, safeWidth));
    lines.push(...(state.tab === state.form.questions.length
      ? renderReview(state, theme, safeWidth)
      : renderQuestion(state, theme, safeWidth, view)));
    if (view.warning) lines.push("", theme.fg("warning", view.warning));
    if (config.behaviour.showFooterHints && view.mode === "main") {
      lines.push(divider(theme, safeWidth));
      lines.push(theme.fg("dim", mainFooter(state, config)));
    }
    lines.push(divider(theme, safeWidth));
  }
  const fitted = lines.map((line) => fit(line, safeWidth));
  if (view.mode === "settings" || view.maxHeight === undefined) return fitted;
  const footerLines = config.behaviour.showFooterHints && view.mode === "main" ? 3 : 1;
  return viewport(fitted, theme, safeWidth, Math.max(1, view.maxHeight), view.scrollOffset ?? 0, footerLines);
}

export function formatCallTranscript(args: unknown): string {
  const root = args && typeof args === "object" ? args as { title?: unknown; questions?: unknown[] } : {};
  const count = Array.isArray(root.questions) ? root.questions.length : 0;
  return `ask_user ${count} question${count === 1 ? "" : "s"}${typeof root.title === "string" && root.title.trim() ? ` · ${root.title.trim()}` : ""}`;
}

export function formatResultTranscript(details: {
  cancelled?: boolean;
  error?: unknown;
  mode?: string;
  questions?: Array<{ id: string; label: string; prompt?: string }>;
  answers?: Record<string, { labels: string[] }>;
  elaboration?: { items?: Array<{
    target: { kind: "question" } | { kind: "option"; optionValue: string };
    question: { prompt: string };
    option?: { label: string };
    answer?: { labels: string[] };
    note: string;
  }> };
}): string[] {
  if (details.error) return ["Invalid tool payload"];
  if (details.cancelled) return ["Cancelled"];
  if (details.mode === "elaborate") {
    const items = details.elaboration?.items ?? [];
    if (items.length) return items.map((item) => {
      const target = item.target.kind === "option" ? ` option ${JSON.stringify(item.option?.label ?? item.target.optionValue)}` : "";
      const current = item.answer?.labels.length ? `; current answer: ${item.answer.labels.join(", ")}` : "";
      return `↻ User asked to elaborate on question ${JSON.stringify(item.question.prompt)}${target} with note ${JSON.stringify(item.note)}${current}`;
    });
    const committed = (details.questions ?? []).filter((question) => Object.hasOwn(details.answers ?? {}, question.id) && details.answers?.[question.id]?.labels.length);
    if (committed.length) return committed.map((question) =>
      `↻ User asked to elaborate on question ${JSON.stringify(question.prompt ?? question.label)}; current answer: ${details.answers![question.id]!.labels.join(", ")}`);
  }
  return (details.questions ?? []).map((question) => {
    const labels = Object.hasOwn(details.answers ?? {}, question.id) ? details.answers?.[question.id]?.labels : undefined;
    return `${labels?.length ? "✓" : "?"} ${question.label}: ${labels?.join(", ") || "(no answer)"}`;
  });
}
