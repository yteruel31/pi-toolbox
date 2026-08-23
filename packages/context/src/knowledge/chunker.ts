import { createHash } from "node:crypto";
import remarkFrontmatter from "remark-frontmatter";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { KnowledgeChunk } from "./schema.js";

export const LARGE_SOURCE_CHARS = 120_000;
export const DEFAULT_MAX_CHUNK_CHARS = 3_000;
export const DEFAULT_MIN_CHUNK_CHARS = 200;
export const CHUNK_OVERLAP_CHARS = 200;
const parser = unified().use(remarkParse).use(remarkFrontmatter, ["yaml", "toml"]);

interface Piece { text: string; heading: string; startLine: number; charOffset: number }
const points = (text: string) => Array.from(text);
const pointLength = (text: string) => points(text).length;
const lineAt = (text: string, offset: number) => text.slice(0, offset).split("\n").length - 1;
const headingText = (node: any): string => typeof node?.value === "string" ? node.value : (node?.children ?? []).map(headingText).join("");

function astPieces(content: string): Piece[] {
  const tree = parser.parse(content) as any;
  const hierarchy: string[] = [];
  const output: Piece[] = [];
  for (const node of tree.children ?? []) {
    const start = Number(node.position?.start?.offset ?? 0);
    const end = Number(node.position?.end?.offset ?? start) + 1;
    if (node.type === "heading") {
      const depth = Math.max(1, Number(node.depth));
      hierarchy.length = depth - 1;
      hierarchy[depth - 1] = headingText(node).trim();
    }
    output.push({
      text: content.slice(start, end),
      heading: hierarchy.filter(Boolean).join(" > ") || "intro",
      startLine: Number(node.position?.start?.line ?? 1) - 1,
      charOffset: start,
    });
  }
  return output;
}

function linearPieces(content: string): Piece[] {
  const hierarchy: string[] = [];
  const output: Piece[] = [];
  let offset = 0, blockStart = 0, inFence = false;
  const flush = (end: number) => {
    if (end <= blockStart) return;
    const text = content.slice(blockStart, end);
    if (text.trim()) output.push({ text, heading: hierarchy.filter(Boolean).join(" > ") || "intro", startLine: lineAt(content, blockStart), charOffset: blockStart });
    blockStart = end;
  };
  for (const line of content.split(/(?<=\n)/)) {
    const trimmed = line.trimStart();
    if (/^(```|~~~)/.test(trimmed)) inFence = !inFence;
    const match = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(trimmed) : null;
    if (match) {
      flush(offset);
      const depth = match[1]!.length;
      hierarchy.length = depth - 1;
      hierarchy[depth - 1] = match[2]!.replace(/\s+#+\s*$/, "").trim();
    }
    offset += line.length;
    if (!inFence && /^\s*$/.test(line)) flush(offset);
  }
  flush(content.length);
  return output;
}

function hardSplit(piece: Piece, maximum: number): Piece[] {
  const chars = points(piece.text);
  if (chars.length <= maximum) return [piece];
  const output: Piece[] = [];
  let pointOffset = 0;
  while (pointOffset < chars.length) {
    const end = Math.min(pointOffset + maximum, chars.length);
    const prefix = chars.slice(0, pointOffset).join("");
    output.push({ text: chars.slice(pointOffset, end).join(""), heading: piece.heading, startLine: piece.startLine + lineAt(piece.text, prefix.length), charOffset: piece.charOffset + prefix.length });
    if (end === chars.length) break;
    pointOffset = end - Math.min(CHUNK_OVERLAP_CHARS, maximum - 1);
  }
  return output;
}

export function chunkKnowledge(content: string, sourcePath = "", maximum = DEFAULT_MAX_CHUNK_CHARS, minimum = DEFAULT_MIN_CHUNK_CHARS): KnowledgeChunk[] {
  if (!content.trim()) return [];
  const blocks = content.length > LARGE_SOURCE_CHARS ? linearPieces(content) : astPieces(content);
  const grouped: Piece[] = [];
  for (const block of blocks) {
    const previous = grouped.at(-1);
    if (previous && previous.heading === block.heading && pointLength(previous.text) + pointLength(block.text) <= maximum) previous.text += content.slice(previous.charOffset + previous.text.length, block.charOffset) + block.text;
    else grouped.push({ ...block });
  }
  const split = grouped.flatMap((piece) => hardSplit(piece, maximum));
  const merged: Piece[] = [];
  for (const piece of split) {
    const previous = merged.at(-1);
    if (previous && (pointLength(piece.text) < minimum || pointLength(previous.text) < minimum) && pointLength(previous.text) + pointLength(piece.text) + 2 <= maximum) previous.text += `\n\n${piece.text}`;
    else merged.push({ ...piece });
  }
  return merged.map((piece, ordinal) => ({
    id: createHash("sha256").update(`${sourcePath}\0${ordinal}\0${piece.text}`).digest("hex").slice(0, 32),
    ordinal,
    heading: piece.heading,
    text: piece.text.trim(),
    startLine: piece.startLine,
    charOffset: piece.charOffset,
  }));
}
