import { stripVTControlCharacters } from "node:util";

import { keyHint, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text, type Component } from "@earendil-works/pi-tui";

import { diagnosticSummary, formatDiagnosticCode, severityLabel } from "./diagnostics.js";
import type { Diagnostic, DiagnosticCardData, LspToolDetails } from "./types.js";

function safeText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function severityColor(diagnostic: Diagnostic): "error" | "warning" | "muted" | "dim" {
  const severity = severityLabel(diagnostic);
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  if (severity === "info") return "muted";
  return "dim";
}

export function renderDiagnosticCard(
  data: DiagnosticCardData,
  expanded: boolean,
  theme: Theme,
  padding = 1,
): Component {
  const box = new Box(padding, 1, (text) => theme.bg("customMessageBg", text));
  const titleColor = data.cleared ? "success" : data.counts.errors > 0 ? "error" : "warning";
  const icon = data.cleared ? "✓" : "⚠";
  const delayed = data.delayed ? theme.fg("dim", " · delayed") : "";
  box.addChild(new Text(`${theme.fg(titleColor, `${icon} LSP`)} ${theme.fg("muted", `· ${safeText(data.file)}`)}${delayed}`, 0, 0));
  box.addChild(new Text(theme.fg("dim", safeText(diagnosticSummary(data))), 0, 0));

  const limit = expanded ? data.diagnostics.length : Math.min(3, data.diagnostics.length);
  for (const diagnostic of data.diagnostics.slice(0, limit)) {
    const location = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
    const code = safeText(formatDiagnosticCode(diagnostic));
    const message = safeText(diagnostic.message.replace(/\s+/g, " ").trim());
    box.addChild(
      new Text(
        `  ${theme.fg("dim", location)}  ${theme.fg(severityColor(diagnostic), code)}  ${theme.fg("customMessageText", message)}`,
        0,
        0,
      ),
    );
  }

  const hidden = data.diagnostics.length - limit + data.omitted;
  if (hidden > 0) {
    const hint = expanded ? `${hidden} additional diagnostic${hidden === 1 ? "" : "s"} omitted` : `${hidden} more · ${keyHint("app.tools.expand", "expand")}`;
    box.addChild(new Text(theme.fg("dim", `  ${hint}`), 0, 0));
  }
  return box;
}

export function renderLspCall(args: { action?: string; file?: string; symbol?: string }, theme: Theme): Component {
  const suffix = safeText([args.action, args.file, args.symbol].filter(Boolean).join(" "));
  return new Text(`${theme.fg("toolTitle", theme.bold("lsp"))}${suffix ? ` ${theme.fg("muted", suffix)}` : ""}`, 0, 0);
}

export function renderLspResult(
  details: LspToolDetails | undefined,
  content: string,
  expanded: boolean,
  isPartial: boolean,
  theme: Theme,
): Component {
  if (isPartial) return new Text(theme.fg("warning", safeText(content || "Waiting for language server…")), 0, 0);
  if (!details) return new Text(safeText(content), 0, 0);
  if (details.error) return new Text(theme.fg("error", safeText(details.error)), 0, 0);

  const color = details.applied === true ? "success" : details.action === "rename" ? "warning" : "accent";
  const shown = expanded ? details.lines : details.lines.slice(0, 8);
  let text = theme.fg(color, safeText(details.summary));
  if (shown.length > 0) text += `\n${shown.map((line) => theme.fg("toolOutput", safeText(line))).join("\n")}`;
  const hidden = details.lines.length - shown.length;
  if (hidden > 0) text += `\n${theme.fg("dim", `${hidden} more · ${keyHint("app.tools.expand", "expand")}`)}`;
  return new Text(text, 0, 0);
}
