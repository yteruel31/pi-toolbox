import { randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { pathIsWithin, rangeToOffsets, uriToFile } from "./paths.js";
import type { TextEdit, WorkspaceEdit } from "./types.js";

interface OffsetEdit extends TextEdit {
  startOffset: number;
  endOffset: number;
}

interface CollectedFileEdits {
  edits: TextEdit[];
  documentVersion?: number;
}

export interface WorkspaceEditTargets {
  filePaths: string[];
  documentVersions: Map<string, number>;
}

export interface PlannedFileEdit {
  filePath: string;
  edits: OffsetEdit[];
  before: string;
  after: string;
}

export interface WorkspaceEditPlan {
  files: PlannedFileEdit[];
  editCount: number;
}

function isTextDocumentEdit(value: unknown): value is {
  textDocument: { uri?: unknown; version?: unknown };
  edits: Array<TextEdit & { insertTextFormat?: number }>;
} {
  return typeof value === "object" && value !== null && "textDocument" in value && "edits" in value && Array.isArray(value.edits);
}

function collectEdits(edit: WorkspaceEdit, workspaceRoot: string): Map<string, CollectedFileEdits> {
  const groups = new Map<string, CollectedFileEdits>();
  let editCount = 0;
  const add = (
    uri: string,
    edits: Array<TextEdit | { range: TextEdit["range"]; newText: string; insertTextFormat?: number }>,
    documentVersion?: number,
  ) => {
    const filePath = uriToFile(uri);
    if (!pathIsWithin(workspaceRoot, filePath)) throw new Error(`Workspace edit targets a file outside the workspace: ${filePath}`);
    if (!groups.has(filePath) && groups.size >= 500) throw new Error("Workspace edit exceeds the 500-file safety limit");
    editCount += edits.length;
    if (editCount > 5_000) throw new Error("Workspace edit exceeds the 5000-edit safety limit");

    const target = groups.get(filePath) ?? { edits: [] };
    if (documentVersion !== undefined) {
      if (target.documentVersion !== undefined && target.documentVersion !== documentVersion) {
        throw new Error(`Workspace edit contains conflicting document versions for ${filePath}`);
      }
      target.documentVersion = documentVersion;
    }
    for (const candidate of edits) {
      if ("insertTextFormat" in candidate && candidate.insertTextFormat === 2) {
        throw new Error(`Snippet workspace edits are not supported: ${filePath}`);
      }
      target.edits.push({ range: candidate.range, newText: candidate.newText });
    }
    groups.set(filePath, target);
  };

  for (const [uri, edits] of Object.entries(edit.changes ?? {})) add(uri, edits);
  for (const change of edit.documentChanges ?? []) {
    if (!isTextDocumentEdit(change)) {
      throw new Error("Workspace file create, rename, and delete operations are not supported in v1");
    }
    if (typeof change.textDocument.uri !== "string") throw new Error("Workspace edit is missing a text document URI");
    const version = change.textDocument.version;
    if (version !== undefined && version !== null && !Number.isInteger(version)) {
      throw new Error(`Workspace edit has an invalid document version for ${change.textDocument.uri}`);
    }
    add(change.textDocument.uri, change.edits, typeof version === "number" ? version : undefined);
  }
  return groups;
}

function applyTextEdits(text: string, edits: TextEdit[], filePath: string): { after: string; offsets: OffsetEdit[] } {
  const offsets: OffsetEdit[] = edits.map((edit) => {
    const { start, end } = rangeToOffsets(text, edit.range);
    return { ...edit, startOffset: start, endOffset: end };
  });
  offsets.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  for (let index = 1; index < offsets.length; index += 1) {
    const previous = offsets[index - 1];
    const current = offsets[index];
    if (previous && current && previous.endOffset > current.startOffset) {
      throw new Error(`Overlapping workspace edits for ${filePath}`);
    }
  }

  let after = text;
  for (const edit of [...offsets].reverse()) {
    after = `${after.slice(0, edit.startOffset)}${edit.newText}${after.slice(edit.endOffset)}`;
  }
  return { after, offsets };
}

async function canonicalPaths(filePaths: string[], workspaceRoot: string): Promise<string[]> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const resolved = new Set<string>();
  for (const filePath of filePaths) {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error(`Workspace edits cannot replace symbolic links: ${filePath}`);
    const canonical = await realpath(filePath);
    if (!pathIsWithin(realWorkspaceRoot, canonical)) {
      throw new Error(`Workspace edit resolves outside the workspace: ${filePath}`);
    }
    resolved.add(canonical);
  }
  return [...resolved].sort();
}

async function buildPlan(
  groups: Map<string, CollectedFileEdits>,
  workspaceRoot: string,
  expectedContents?: ReadonlyMap<string, string>,
): Promise<WorkspaceEditPlan> {
  const files: PlannedFileEdit[] = [];
  let editCount = 0;
  const seenCanonical = new Map<string, string>();
  const realWorkspaceRoot = await realpath(workspaceRoot);

  for (const [filePath, group] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if ((await lstat(filePath)).isSymbolicLink()) throw new Error(`Workspace edits cannot replace symbolic links: ${filePath}`);
    const canonical = await realpath(filePath);
    if (!pathIsWithin(realWorkspaceRoot, canonical)) {
      throw new Error(`Workspace edit resolves outside the workspace: ${filePath}`);
    }
    const alias = seenCanonical.get(canonical);
    if (alias && alias !== filePath) {
      throw new Error(`Workspace edit addresses the same file through multiple paths: ${alias}, ${filePath}`);
    }
    seenCanonical.set(canonical, filePath);

    const before = await readFile(filePath, "utf8");
    const expected = expectedContents?.get(filePath);
    if (expected !== undefined && before !== expected) {
      throw new Error(`File changed while the language server prepared its workspace edit: ${filePath}`);
    }
    const { after, offsets } = applyTextEdits(before, group.edits, filePath);
    files.push({ filePath, edits: offsets, before, after });
    editCount += group.edits.length;
  }
  return { files, editCount };
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const mode = (await stat(filePath)).mode;
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.pi-lsp-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await chmod(temporary, mode);
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function applyPlan(plan: WorkspaceEditPlan): Promise<WorkspaceEditPlan> {
  const written: PlannedFileEdit[] = [];
  try {
    for (const file of plan.files) {
      if (file.before === file.after) continue;
      await atomicWrite(file.filePath, file.after);
      written.push(file);
    }
  } catch (error) {
    const rollback = await Promise.allSettled(written.map((file) => atomicWrite(file.filePath, file.before)));
    const failedRollbacks = rollback.flatMap((result, index) => result.status === "rejected" ? [written[index]!.filePath] : []);
    if (failedRollbacks.length > 0) {
      throw new AggregateError(
        [error, ...rollback.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason)],
        `Workspace edit failed and rollback also failed for: ${failedRollbacks.join(", ")}`,
      );
    }
    throw error;
  }
  return plan;
}

async function withQueues<T>(queuePaths: string[], fn: () => Promise<T>, index = 0): Promise<T> {
  const queuePath = queuePaths[index];
  if (!queuePath) return fn();
  return withFileMutationQueue(queuePath, () => withQueues(queuePaths, fn, index + 1));
}

export function inspectWorkspaceEdit(edit: WorkspaceEdit, workspaceRoot: string): WorkspaceEditTargets {
  const groups = collectEdits(edit, workspaceRoot);
  if (groups.size === 0) throw new Error("Language server returned an empty workspace edit");
  return {
    filePaths: [...groups.keys()],
    documentVersions: new Map(
      [...groups.entries()].flatMap(([filePath, group]) => group.documentVersion === undefined ? [] : [[filePath, group.documentVersion] as const]),
    ),
  };
}

export async function canonicalWorkspacePaths(filePaths: string[], workspaceRoot: string): Promise<string[]> {
  return canonicalPaths(filePaths, workspaceRoot);
}

export async function withWorkspaceMutationQueues<T>(
  filePaths: string[],
  workspaceRoot: string,
  fn: (canonicalLockedPaths: readonly string[]) => Promise<T>,
): Promise<T> {
  const queuePaths = await canonicalPaths(filePaths, workspaceRoot);
  return withQueues(queuePaths, () => fn(queuePaths));
}

export async function planWorkspaceEdit(
  edit: WorkspaceEdit,
  workspaceRoot: string,
  expectedContents?: ReadonlyMap<string, string>,
): Promise<WorkspaceEditPlan> {
  const groups = collectEdits(edit, workspaceRoot);
  if (groups.size === 0) throw new Error("Language server returned an empty workspace edit");
  return buildPlan(groups, workspaceRoot, expectedContents);
}

export async function applyWorkspaceEditLocked(
  edit: WorkspaceEdit,
  workspaceRoot: string,
  expectedContents?: ReadonlyMap<string, string>,
): Promise<WorkspaceEditPlan> {
  const groups = collectEdits(edit, workspaceRoot);
  if (groups.size === 0) throw new Error("Language server returned an empty workspace edit");
  return applyPlan(await buildPlan(groups, workspaceRoot, expectedContents));
}

export async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  workspaceRoot: string,
  expectedContents?: ReadonlyMap<string, string>,
): Promise<WorkspaceEditPlan> {
  const targets = inspectWorkspaceEdit(edit, workspaceRoot);
  return withWorkspaceMutationQueues(targets.filePaths, workspaceRoot, () =>
    applyWorkspaceEditLocked(edit, workspaceRoot, expectedContents));
}

function previewReplacement(text: string): string {
  const normalized = text.replace(/\r?\n/g, "\\n");
  return normalized.length > 100 ? `${normalized.slice(0, 97)}...` : normalized;
}

export function formatWorkspaceEditPlan(plan: WorkspaceEditPlan, workspaceRoot: string): string[] {
  const lines = [`${plan.editCount} edit${plan.editCount === 1 ? "" : "s"} across ${plan.files.length} file${plan.files.length === 1 ? "" : "s"}`];
  for (const file of plan.files) {
    lines.push(path.relative(workspaceRoot, file.filePath) || path.basename(file.filePath));
    for (const edit of file.edits) {
      const location = `${edit.range.start.line + 1}:${edit.range.start.character + 1}`;
      lines.push(`  ${location} → ${previewReplacement(edit.newText) || "<delete>"}`);
    }
  }
  return lines;
}
