import { truncateText } from "../shared/truncate.js";
import type { RunStatus } from "../shared/types.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function codePointWidth(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0x09) return 8;
  if (
    codePoint === 0 ||
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
    /\p{Mark}/u.test(character)
  ) {
    return 0;
  }
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function graphemeWidth(grapheme: string): number {
  const widths = Array.from(grapheme, codePointWidth);
  if (grapheme.includes("\u200d")) return Math.max(0, ...widths);
  return widths.reduce((sum, width) => sum + width, 0);
}

/** Conservative visible terminal-cell width for unstyled text. */
export function textWidth(text: string): number {
  return graphemes(text).reduce(
    (sum, grapheme) => sum + graphemeWidth(grapheme),
    0,
  );
}

function takeWidth(text: string, width: number): string {
  if (width <= 0) return "";
  let used = 0;
  let output = "";
  for (const grapheme of graphemes(text)) {
    const nextWidth = graphemeWidth(grapheme);
    if (used + nextWidth > width) break;
    output += grapheme;
    used += nextWidth;
  }
  return output;
}

/** Bound one plain-text line to `width` terminal cells. */
export function fitLine(text: string, width: number): string {
  if (width <= 0) return "";
  const collapsed = text.replace(/[\r\n\t]+/g, " ");
  if (textWidth(collapsed) <= width) return collapsed;
  if (width === 1) return "…";
  return `${takeWidth(collapsed, width - 1)}…`;
}

/** Bound lines by width and keep their newest tail when rows overflow. */
export function fitLines(
  lines: readonly string[],
  width: number,
  maxLines: number,
): string[] {
  if (maxLines <= 0 || width <= 0) return [];
  if (lines.length <= maxLines) {
    return lines.map((line) => fitLine(line, width));
  }
  const tailCount = Math.max(0, maxLines - 1);
  const kept = tailCount === 0 ? [] : lines.slice(-tailCount);
  const dropped = lines.length - kept.length;
  return [
    fitLine(`… ${dropped} earlier line${dropped === 1 ? "" : "s"}`, width),
    ...kept.map((line) => fitLine(line, width)),
  ];
}

/**
 * Bound a selectable list while keeping the selected row visible. Omission
 * markers consume rows, so the result never exceeds `maxLines`.
 */
export function fitViewport(
  lines: readonly string[],
  selectedIndex: number,
  width: number,
  maxLines: number,
): string[] {
  if (maxLines <= 0 || width <= 0 || lines.length === 0) return [];
  if (lines.length <= maxLines) {
    return lines.map((line) => fitLine(line, width));
  }

  const selected = Math.min(Math.max(0, selectedIndex), lines.length - 1);
  if (maxLines === 1) return [fitLine(lines[selected] ?? "", width)];

  let showTop = selected > 0;
  let showBottom = selected < lines.length - 1;
  let start = selected;
  let end = selected + 1;

  for (let pass = 0; pass < 4; pass += 1) {
    const slots = Math.max(
      1,
      maxLines - (showTop ? 1 : 0) - (showBottom ? 1 : 0),
    );
    start = Math.min(
      Math.max(0, selected - Math.floor((slots - 1) / 2)),
      Math.max(0, lines.length - slots),
    );
    end = Math.min(lines.length, start + slots);
    const nextTop = start > 0;
    const nextBottom = end < lines.length;
    if (nextTop === showTop && nextBottom === showBottom) break;
    showTop = nextTop;
    showBottom = nextBottom;
  }

  const output: string[] = [];
  if (start > 0) output.push(fitLine(`… ${start} earlier`, width));
  output.push(...lines.slice(start, end).map((line) => fitLine(line, width)));
  if (end < lines.length) {
    output.push(fitLine(`… ${lines.length - end} later`, width));
  }
  return output.slice(0, maxLines);
}

/** Keep fixed header rows and the newest body rows when details overflow. */
export function fitHeadTailLines(
  lines: readonly string[],
  width: number,
  maxLines: number,
  headLines: number,
): string[] {
  if (maxLines <= 0 || width <= 0) return [];
  if (lines.length <= maxLines) {
    return lines.map((line) => fitLine(line, width));
  }
  const headCount = Math.min(Math.max(0, headLines), maxLines, lines.length);
  const head = lines.slice(0, headCount);
  const remaining = maxLines - headCount;
  if (remaining === 0) return head.map((line) => fitLine(line, width));
  const tailCount = Math.max(0, remaining - 1);
  const tail = tailCount === 0 ? [] : lines.slice(-tailCount);
  const dropped = lines.length - head.length - tail.length;
  return [
    ...head.map((line) => fitLine(line, width)),
    fitLine(`… ${dropped} omitted line${dropped === 1 ? "" : "s"}`, width),
    ...tail.map((line) => fitLine(line, width)),
  ].slice(0, maxLines);
}

/** Hard-wrap a text blob into terminal-cell-bounded display lines. */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [];
  const output: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[\r\t]/g, " ");
    if (line.length === 0) {
      output.push("");
      continue;
    }
    let current = "";
    let currentWidth = 0;
    for (const grapheme of graphemes(line)) {
      const widthOfGrapheme = graphemeWidth(grapheme);
      if (widthOfGrapheme > width) {
        if (current.length > 0) output.push(current);
        output.push("…");
        current = "";
        currentWidth = 0;
        continue;
      }
      if (currentWidth + widthOfGrapheme > width) {
        output.push(current);
        current = grapheme;
        currentWidth = widthOfGrapheme;
      } else {
        current += grapheme;
        currentWidth += widthOfGrapheme;
      }
    }
    if (current.length > 0) output.push(current);
  }
  return output;
}

/** Compact elapsed time for list rows. */
export function formatElapsed(ms: number): string {
  const safeMs = Number.isFinite(ms) ? ms : 0;
  const totalSeconds = Math.max(0, Math.floor(safeMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

export function statusGlyph(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "·";
    case "running":
      return "●";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "cancelled":
      return "⊘";
  }
}

export function statusLabel(status: RunStatus): string {
  return status;
}

export function boundNotice(text: string, maxChars = 200): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), maxChars);
}
