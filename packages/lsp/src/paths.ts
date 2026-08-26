import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Position, Range, ServerDefinition } from "./types.js";

export function fileToUri(filePath: string): string {
  return pathToFileURL(path.resolve(filePath)).href;
}

export function uriToFile(uri: string): string {
  const url = new URL(uri);
  if (url.protocol !== "file:") throw new Error(`Unsupported LSP URI: ${uri}`);
  return fileURLToPath(url);
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeToolPath(cwd: string, input: string): string {
  const clean = input.startsWith("@") ? input.slice(1) : input;
  const resolved = path.resolve(cwd, clean);
  if (!pathIsWithin(cwd, resolved)) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
  return resolved;
}

export function fileType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  return extension || path.basename(filePath).toLowerCase();
}

export function supportsFile(server: ServerDefinition, filePath: string): boolean {
  const type = fileType(filePath);
  const withoutDot = type.startsWith(".") ? type.slice(1) : type;
  return server.fileTypes.some((candidate) => {
    const normalized = candidate.toLowerCase();
    const candidateWithoutDot = normalized.startsWith(".") ? normalized.slice(1) : normalized;
    return normalized === type || candidateWithoutDot === withoutDot;
  });
}

export function languageIdFor(server: ServerDefinition, filePath: string): string {
  const type = fileType(filePath);
  return server.languageIds[type] ?? server.languageIds[type.replace(/^\./, "")] ?? (type.replace(/^\./, "") || "plaintext");
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(filePath: string, workspace: string, markers: string[]): Promise<string | null> {
  const workspaceRoot = path.resolve(workspace);
  if (!pathIsWithin(workspaceRoot, filePath)) return null;
  if (markers.includes(".")) return workspaceRoot;

  let directory = path.dirname(path.resolve(filePath));
  while (pathIsWithin(workspaceRoot, directory)) {
    for (const marker of markers) {
      if (await exists(path.join(directory, marker))) return directory;
    }
    if (directory === workspaceRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function executableNames(command: string): string[] {
  if (process.platform !== "win32") return [command];
  if (path.extname(command)) return [command];
  const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function ancestorsFrom(start: string, boundary: string): string[] {
  const result: string[] = [];
  let current = path.resolve(start);
  const root = path.resolve(boundary);
  while (pathIsWithin(root, current)) {
    result.push(current);
    if (current === root) break;
    current = path.dirname(current);
  }
  return result;
}

export async function resolveExecutable(command: string, projectRoot: string, workspace: string): Promise<string | null> {
  const containsSeparator = command.includes("/") || command.includes("\\");
  if (path.isAbsolute(command) || containsSeparator) {
    const candidate = path.isAbsolute(command) ? command : path.resolve(projectRoot, command);
    return (await isExecutable(candidate)) ? candidate : null;
  }

  const localDirectories = [
    "node_modules/.bin",
    ".venv/bin",
    ".venv/Scripts",
    "venv/bin",
    "venv/Scripts",
    ".env/bin",
    ".env/Scripts",
    "bin",
  ];
  for (const root of ancestorsFrom(projectRoot, workspace)) {
    for (const directory of localDirectories) {
      for (const name of executableNames(command)) {
        const candidate = path.join(root, directory, name);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }

  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of executableNames(command)) {
      const candidate = path.join(directory, name);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export function positionToOffset(text: string, position: Position): number {
  if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0) {
    throw new Error(`Invalid LSP position ${position.line}:${position.character}`);
  }

  let offset = 0;
  for (let line = 0; line < position.line; line += 1) {
    const newline = text.indexOf("\n", offset);
    if (newline === -1) throw new Error(`LSP position line ${position.line + 1} is outside the document`);
    offset = newline + 1;
  }

  const lineEnd = text.indexOf("\n", offset);
  const contentEnd = lineEnd === -1 ? text.length : lineEnd;
  const rawEnd = contentEnd > offset && text[contentEnd - 1] === "\r" ? contentEnd - 1 : contentEnd;
  if (offset + position.character > rawEnd) {
    throw new Error(`LSP position character ${position.character + 1} is outside line ${position.line + 1}`);
  }
  return offset + position.character;
}

export function rangeToOffsets(text: string, range: Range): { start: number; end: number } {
  const start = positionToOffset(text, range.start);
  const end = positionToOffset(text, range.end);
  if (end < start) throw new Error("LSP edit range ends before it starts");
  return { start, end };
}
