import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { LspResponseError, type LspClient } from "./client.js";
import { countDiagnostics, formatDiagnosticCode, severityLabel } from "./diagnostics.js";
import { fileToUri, normalizeToolPath, supportsFile, uriToFile } from "./paths.js";
import type { LspRegistry } from "./registry.js";
import type {
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  LspToolDetails,
  Position,
  SymbolInformation,
  WorkspaceEdit,
} from "./types.js";
import {
  applyWorkspaceEditLocked,
  canonicalWorkspacePaths,
  formatWorkspaceEditPlan,
  inspectWorkspaceEdit,
  planWorkspaceEdit,
  withWorkspaceMutationQueues,
  type WorkspaceEditTargets,
} from "./workspace-edit.js";

export const LSP_ACTIONS = ["diagnostics", "definition", "references", "hover", "symbols", "rename", "status", "reload"] as const;
export type LspAction = (typeof LSP_ACTIONS)[number];

export interface LspToolInput {
  action: LspAction;
  file?: string;
  line?: number;
  symbol?: string;
  query?: string;
  new_name?: string;
  apply?: boolean;
  timeout?: number;
}

interface OperationContext {
  cwd: string;
  registry: LspRegistry;
  reload: () => Promise<LspRegistry>;
}

const SYMBOL_KINDS = [
  "File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum",
  "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key",
  "Null", "EnumMember", "Struct", "Event", "Operator", "TypeParameter",
];

function timeoutMs(input: LspToolInput): number {
  return (input.timeout ?? 20) * 1_000;
}

function requiredFile(input: LspToolInput, cwd: string): string {
  if (!input.file) throw new Error(`lsp ${input.action} requires file`);
  return normalizeToolPath(cwd, input.file);
}

function requiredPositionInput(input: LspToolInput): { line: number; symbol: string } {
  if (!input.line || input.line < 1) throw new Error(`lsp ${input.action} requires a 1-indexed line`);
  if (!input.symbol) throw new Error(`lsp ${input.action} requires symbol`);
  return { line: input.line, symbol: input.symbol };
}

async function resolvePosition(filePath: string, lineNumber: number, selector: string): Promise<Position> {
  const text = await readFile(filePath, "utf8");
  const line = text.split(/\r?\n/)[lineNumber - 1];
  if (line === undefined) throw new Error(`Line ${lineNumber} is outside ${filePath}`);

  const selectorMatch = selector.match(/^(.*)#([1-9]\d*)$/);
  const symbol = selectorMatch?.[1] ?? selector;
  const occurrence = selectorMatch ? Number(selectorMatch[2]) : 1;
  if (!symbol) throw new Error("Symbol cannot be empty");

  let from = 0;
  let index = -1;
  for (let current = 0; current < occurrence; current += 1) {
    index = line.indexOf(symbol, from);
    if (index === -1) {
      throw new Error(`Could not find ${JSON.stringify(symbol)}${occurrence > 1 ? ` occurrence #${occurrence}` : ""} on line ${lineNumber}`);
    }
    from = index + symbol.length;
  }
  return { line: lineNumber - 1, character: index };
}

function normalizeLocations(value: unknown): Location[] {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  const locations: Location[] = [];
  for (const candidate of values) {
    if (typeof candidate !== "object" || candidate === null) continue;
    if ("targetUri" in candidate && typeof (candidate as LocationLink).targetUri === "string") {
      const link = candidate as LocationLink;
      locations.push({ uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange });
    } else if ("uri" in candidate && typeof (candidate as Location).uri === "string") {
      locations.push(candidate as Location);
    }
  }
  return locations;
}

async function locationLine(location: Location, cwd: string): Promise<string> {
  const filePath = uriToFile(location.uri);
  const relative = path.relative(cwd, filePath) || path.basename(filePath);
  const prefix = `${relative}:${location.range.start.line + 1}:${location.range.start.character + 1}`;
  try {
    const source = (await readFile(filePath, "utf8")).split(/\r?\n/)[location.range.start.line]?.trim();
    return source ? `${prefix}  ${source}` : prefix;
  } catch {
    return prefix;
  }
}

function hoverText(hover: Hover | null): string[] {
  if (!hover) return [];
  const contents = hover.contents;
  if (typeof contents === "string") return [contents];
  if (Array.isArray(contents)) {
    return contents.map((item) => (typeof item === "string" ? item : `\`\`\`${item.language}\n${item.value}\n\`\`\``));
  }
  if ("kind" in contents) return [contents.value];
  return [`\`\`\`${contents.language}\n${contents.value}\n\`\`\``];
}

function validateDocumentVersions(client: LspClient, targets: WorkspaceEditTargets): void {
  for (const [filePath, expectedVersion] of targets.documentVersions) {
    const actualVersion = client.openDocumentVersion(filePath);
    if (actualVersion === undefined || actualVersion !== expectedVersion) {
      throw new Error(`Language server returned a stale or unverifiable document version for ${filePath}`);
    }
  }
}

function diagnosticLines(file: string, diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((diagnostic) => {
    const position = `${file}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
    return `${position} [${severityLabel(diagnostic)}] ${formatDiagnosticCode(diagnostic)} ${diagnostic.message.replace(/\s+/g, " ").trim()}`;
  });
}

function flattenDocumentSymbols(symbols: DocumentSymbol[], query: string | undefined): string[] {
  const lines: string[] = [];
  const stack = [...symbols].reverse().map((symbol) => ({ symbol, depth: 0 }));
  let visited = 0;
  while (stack.length > 0 && lines.length < 200 && visited < 5_000) {
    const item = stack.pop();
    if (!item) break;
    visited += 1;
    const { symbol, depth } = item;
    const matches = !query || `${symbol.name} ${symbol.detail ?? ""}`.toLowerCase().includes(query.toLowerCase());
    if (matches) {
      const kind = SYMBOL_KINDS[symbol.kind - 1] ?? `Kind${symbol.kind}`;
      lines.push(`${"  ".repeat(Math.min(depth, 20))}${symbol.name} [${kind}] ${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character + 1}${symbol.detail ? ` — ${symbol.detail}` : ""}`);
    }
    if (symbol.children && depth < 100) {
      for (const child of [...symbol.children].reverse()) stack.push({ symbol: child, depth: depth + 1 });
    }
  }
  return lines;
}

function symbolInformationLines(symbols: SymbolInformation[], cwd: string, query?: string): string[] {
  return symbols
    .filter((symbol) => !query || `${symbol.name} ${symbol.containerName ?? ""}`.toLowerCase().includes(query.toLowerCase()))
    .slice(0, 200)
    .map((symbol) => {
      const kind = SYMBOL_KINDS[symbol.kind - 1] ?? `Kind${symbol.kind}`;
      const file = path.relative(cwd, uriToFile(symbol.location.uri));
      return `${symbol.name} [${kind}] ${file}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`;
    });
}

export async function executeLspOperation(context: OperationContext, input: LspToolInput, signal?: AbortSignal): Promise<LspToolDetails> {
  if (input.action === "status") {
    const statuses = await context.registry.status();
    const lines = statuses.map((status) => {
      const state = status.running ? "running" : status.available ? "available" : status.root ? "binary missing" : "not detected";
      return `${status.name}: ${state} (${status.command})${status.root ? ` root=${path.relative(context.cwd, status.root) || "."}` : ""}${status.error ? ` — ${status.error}` : ""}`;
    });
    lines.push(...context.registry.config.warnings.map((warning) => `config warning: ${warning}`));
    if (!context.registry.projectTrusted) lines.unshift("LSP execution is disabled until this project is trusted.");
    return {
      action: input.action,
      summary: context.registry.projectTrusted
        ? `${statuses.filter((status) => status.available).length}/${statuses.length} language servers available`
        : "LSP disabled for untrusted project",
      lines,
    };
  }

  if (input.action === "reload") {
    const registry = await context.reload();
    const statuses = await registry.status();
    return {
      action: input.action,
      summary: `Reloaded LSP configuration; ${statuses.filter((status) => status.available).length}/${statuses.length} servers available`,
      lines: registry.config.warnings,
    };
  }

  const filePath = requiredFile(input, context.cwd);
  const file = path.relative(context.cwd, filePath) || path.basename(filePath);

  if (input.action === "diagnostics") {
    const result = await context.registry.syncDiagnostics(filePath, timeoutMs(input), signal);
    if (!result) throw new Error(`No language server is available for ${file}`);
    const diagnostics = result.diagnostics.diagnostics;
    const counts = countDiagnostics(diagnostics);
    return {
      action: input.action,
      summary: `${file}: ${counts.errors} errors, ${counts.warnings} warnings, ${counts.information} info, ${counts.hints} hints`,
      lines: diagnosticLines(file, diagnostics),
    };
  }

  const client = await context.registry.prepareFile(filePath, signal);

  if (input.action === "symbols") {
    const result = await client.request<DocumentSymbol[] | SymbolInformation[] | null>(
      "textDocument/documentSymbol",
      { textDocument: { uri: fileToUri(filePath) } },
      { signal, timeoutMs: timeoutMs(input) },
    );
    const symbols = result ?? [];
    const lines = symbols.length > 0 && "selectionRange" in symbols[0]!
      ? flattenDocumentSymbols(symbols as DocumentSymbol[], input.query)
      : symbolInformationLines(symbols as SymbolInformation[], context.cwd, input.query);
    return { action: input.action, summary: `${lines.length} symbol${lines.length === 1 ? "" : "s"} in ${file}`, lines };
  }

  const { line, symbol } = requiredPositionInput(input);
  const position = await resolvePosition(filePath, line, symbol);
  const positionParams = { textDocument: { uri: fileToUri(filePath) }, position };

  if (input.action === "hover") {
    const result = await client.request<Hover | null>("textDocument/hover", positionParams, { signal, timeoutMs: timeoutMs(input) });
    const lines = hoverText(result);
    return { action: input.action, summary: lines.length > 0 ? `Hover for ${symbol} in ${file}:${line}` : `No hover information for ${symbol}`, lines };
  }

  if (input.action === "definition" || input.action === "references") {
    const method = input.action === "definition" ? "textDocument/definition" : "textDocument/references";
    const params = input.action === "references" ? { ...positionParams, context: { includeDeclaration: true } } : positionParams;
    const result = await client.request<unknown>(method, params, { signal, timeoutMs: timeoutMs(input) });
    const locations = normalizeLocations(result).slice(0, 200);
    const lines = await Promise.all(locations.map((location) => locationLine(location, context.cwd)));
    const label = input.action === "definition"
      ? `definition${locations.length === 1 ? "" : "s"}`
      : `reference${locations.length === 1 ? "" : "s"}`;
    return { action: input.action, summary: `${locations.length} ${label} for ${symbol}`, lines };
  }

  if (input.action === "rename") {
    if (!input.new_name) throw new Error("lsp rename requires new_name");
    try {
      await client.request("textDocument/prepareRename", positionParams, { signal, timeoutMs: timeoutMs(input) });
    } catch (error) {
      if (!(error instanceof LspResponseError) || error.code !== -32601) throw error;
    }
    const edit = await client.request<WorkspaceEdit | null>(
      "textDocument/rename",
      { ...positionParams, newName: input.new_name },
      { signal, timeoutMs: timeoutMs(input) },
    );
    if (!edit) throw new Error(`Language server cannot rename ${symbol}`);
    const synchronizedText = client.openDocumentText(filePath);
    if (synchronizedText === undefined || await readFile(filePath, "utf8") !== synchronizedText) {
      throw new Error(`File changed while the language server prepared the rename: ${file}`);
    }
    const expectedContents = new Map([[filePath, synchronizedText]]);
    const apply = input.apply === true;
    const initialTargets = inspectWorkspaceEdit(edit, context.cwd);
    const plan = apply
      ? await withWorkspaceMutationQueues([filePath, ...initialTargets.filePaths], context.cwd, async (lockedPaths) => {
          for (const target of initialTargets.filePaths) {
            if (supportsFile(client.definition, target)) await client.syncFile(target);
          }
          const freshPosition = await resolvePosition(filePath, line, symbol);
          const freshParams = { textDocument: { uri: fileToUri(filePath) }, position: freshPosition };
          try {
            await client.request("textDocument/prepareRename", freshParams, { signal, timeoutMs: timeoutMs(input) });
          } catch (error) {
            if (!(error instanceof LspResponseError) || error.code !== -32601) throw error;
          }
          const freshEdit = await client.request<WorkspaceEdit | null>(
            "textDocument/rename",
            { ...freshParams, newName: input.new_name },
            { signal, timeoutMs: timeoutMs(input) },
          );
          if (!freshEdit) throw new Error(`Language server cannot rename ${symbol}`);
          const freshTargets = inspectWorkspaceEdit(freshEdit, context.cwd);
          const freshCanonical = await canonicalWorkspacePaths([filePath, ...freshTargets.filePaths], context.cwd);
          const locked = new Set(lockedPaths);
          if (freshCanonical.some((target) => !locked.has(target))) {
            throw new Error("Rename target set changed while acquiring file locks; retry the rename");
          }
          validateDocumentVersions(client, freshTargets);
          const freshExpectedContents = new Map<string, string>();
          for (const target of [filePath, ...freshTargets.filePaths]) {
            const text = client.openDocumentText(target);
            if (text !== undefined) freshExpectedContents.set(target, text);
          }
          return applyWorkspaceEditLocked(freshEdit, context.cwd, freshExpectedContents);
        })
      : await planWorkspaceEdit(edit, context.cwd, expectedContents);
    if (apply) await context.registry.refreshFiles(plan.files.map((planned) => planned.filePath));
    return {
      action: input.action,
      summary: `${apply ? "Applied" : "Previewed"} rename ${symbol} → ${input.new_name}: ${plan.editCount} edits in ${plan.files.length} files`,
      lines: formatWorkspaceEditPlan(plan, context.cwd),
      applied: apply,
    };
  }

  throw new Error(`Unsupported LSP action: ${input.action satisfies never}`);
}

export function lspToolText(details: LspToolDetails): string {
  return [details.summary, ...details.lines].join("\n");
}
