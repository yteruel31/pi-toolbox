import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { Diagnostic, DiagnosticCardData, DiagnosticCounts } from "./types.js";

function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function fingerprint(diagnostic: Diagnostic): string {
  return JSON.stringify([
    diagnostic.severity ?? 1,
    diagnostic.source ?? "",
    diagnostic.code ?? "",
    diagnostic.message.replace(/\s+/g, " ").trim(),
  ]);
}

export function countDiagnostics(diagnostics: Diagnostic[]): DiagnosticCounts {
  const counts: DiagnosticCounts = { errors: 0, warnings: 0, information: 0, hints: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 2) counts.warnings += 1;
    else if (diagnostic.severity === 3) counts.information += 1;
    else if (diagnostic.severity === 4) counts.hints += 1;
    else counts.errors += 1;
  }
  return counts;
}

export class MutationVersions {
  private readonly versions = new Map<string, number>();

  begin(filePath: string): number {
    const next = (this.versions.get(filePath) ?? 0) + 1;
    this.versions.set(filePath, next);
    return next;
  }

  isCurrent(filePath: string, version: number): boolean {
    return this.versions.get(filePath) === version;
  }

  invalidate(filePath: string, version: number): void {
    if (this.isCurrent(filePath, version)) this.versions.set(filePath, version + 1);
  }

  clear(): void {
    this.versions.clear();
  }
}

export class DiagnosticLedger {
  private readonly reported = new Map<string, Map<string, number>>();

  update(
    workspace: string,
    filePath: string,
    server: string,
    diagnostics: Diagnostic[],
    maxDiagnostics: number,
    delayed: boolean,
  ): DiagnosticCardData | null {
    const key = path.resolve(filePath);
    const previous = this.reported.get(key) ?? new Map<string, number>();
    const current = new Map<string, number>();
    for (const diagnostic of diagnostics) {
      const identity = fingerprint(diagnostic);
      current.set(identity, (current.get(identity) ?? 0) + 1);
    }
    this.reported.set(key, current);

    if (current.size === 0) {
      if (previous.size === 0) return null;
      return {
        file: path.relative(workspace, filePath) || path.basename(filePath),
        server,
        delayed,
        cleared: true,
        counts: countDiagnostics(diagnostics),
        diagnostics: [],
        omitted: 0,
      };
    }

    const seen = new Map<string, number>();
    const newDiagnostics = diagnostics.filter((diagnostic) => {
      const identity = fingerprint(diagnostic);
      const occurrence = (seen.get(identity) ?? 0) + 1;
      seen.set(identity, occurrence);
      return occurrence > (previous.get(identity) ?? 0);
    });
    if (newDiagnostics.length === 0) return null;
    const displayed = newDiagnostics.slice(0, maxDiagnostics);
    return {
      file: path.relative(workspace, filePath) || path.basename(filePath),
      server,
      delayed,
      cleared: false,
      counts: countDiagnostics(diagnostics),
      diagnostics: displayed,
      omitted: newDiagnostics.length - displayed.length,
    };
  }

  clear(): void {
    this.reported.clear();
  }
}

function diagnosticCode(diagnostic: Diagnostic): string {
  const parts = [diagnostic.source, diagnostic.code].filter((part) => part !== undefined && part !== "");
  return parts.length > 0 ? parts.join(":") : "LSP";
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export function diagnosticSummary(card: DiagnosticCardData): string {
  if (card.cleared) return `LSP diagnostics cleared for ${clean(card.file)} (${clean(card.server)}).`;
  const parts = [
    card.counts.errors > 0 ? plural(card.counts.errors, "error") : "",
    card.counts.warnings > 0 ? plural(card.counts.warnings, "warning") : "",
    card.counts.information > 0 ? plural(card.counts.information, "info") : "",
    card.counts.hints > 0 ? plural(card.counts.hints, "hint") : "",
  ].filter(Boolean);
  return `LSP diagnostics for ${clean(card.file)} (${clean(card.server)}): ${parts.join(", ") || "none"}${card.delayed ? " [delayed]" : ""}.`;
}

export function formatDiagnosticCardForModel(card: DiagnosticCardData): string {
  const lines = [diagnosticSummary(card)];
  for (const diagnostic of card.diagnostics) {
    const location = `${clean(card.file)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
    lines.push(`${location} ${clean(diagnosticCode(diagnostic))} ${clean(diagnostic.message.replace(/\s+/g, " ").trim())}`);
  }
  if (card.omitted > 0) lines.push(`... ${card.omitted} additional new diagnostic${card.omitted === 1 ? "" : "s"} omitted.`);
  return lines.join("\n");
}

export function severityLabel(diagnostic: Diagnostic): "error" | "warning" | "info" | "hint" {
  if (diagnostic.severity === 2) return "warning";
  if (diagnostic.severity === 3) return "info";
  if (diagnostic.severity === 4) return "hint";
  return "error";
}

export function formatDiagnosticCode(diagnostic: Diagnostic): string {
  return diagnosticCode(diagnostic);
}
