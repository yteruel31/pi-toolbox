/**
 * Footer-status and widget text for background runs. Pure text producers:
 * the extension feeds them RunManager.list() output and pushes the results into
 * ctx.ui.setStatus("subagents", ...) / ctx.ui.setWidget("subagents", ...),
 * passing undefined through to clear the slot when there is nothing to show.
 */

import { isSettledStatus } from "../shared/types.js";
import type { RunListEntry } from "../shared/types.js";
import { fitLine, formatElapsed, statusGlyph } from "./text.js";

export interface RunCounts {
  active: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Settled results not yet collected or delivered. */
  pendingDelivery: number;
}

export function countRuns(
  runs: readonly RunListEntry[],
  pendingDelivery = 0,
): RunCounts {
  const counts: RunCounts = {
    active: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    pendingDelivery: Math.max(0, Math.floor(pendingDelivery)),
  };
  for (const run of runs) {
    if (!isSettledStatus(run.status)) counts.active += 1;
    else if (run.status === "completed") counts.completed += 1;
    else if (run.status === "failed") counts.failed += 1;
    else counts.cancelled += 1;
  }
  return counts;
}

/**
 * One-line status for the footer slot, or undefined when the slot should be
 * cleared (no active runs and nothing pending delivery).
 */
export function statusText(
  runs: readonly RunListEntry[],
  pendingDelivery = 0,
): string | undefined {
  const counts = countRuns(runs, pendingDelivery);
  const parts: string[] = [];
  if (counts.active > 0) parts.push(`● ${counts.active} running`);
  if (counts.pendingDelivery > 0) parts.push(`${counts.pendingDelivery} to deliver`);
  if (parts.length === 0) return undefined;
  return fitLine(`subagents: ${parts.join(", ")}`, 80);
}

export interface WidgetOptions {
  width: number;
  /** Max run rows before older/settled rows collapse into a count line. */
  maxLines: number;
}

/**
 * Compact always-visible run list for the editor widget slot, or undefined
 * when the widget should be cleared (no active runs). Active runs win the
 * available rows; a trailing line summarizes what was left out.
 */
export function widgetLines(
  runs: readonly RunListEntry[],
  options: WidgetOptions,
): string[] | undefined {
  const width = Math.floor(options.width);
  const maxLines = Math.floor(options.maxLines);
  if (width <= 0 || maxLines <= 0) return undefined;
  const active = runs.filter((run) => !isSettledStatus(run.status));
  if (active.length === 0) return undefined;

  const lines: string[] = [];
  const roomForRows = active.length > maxLines ? maxLines - 1 : maxLines;
  for (const run of active.slice(0, roomForRows)) {
    lines.push(
      fitLine(
        `${statusGlyph(run.status)} ${run.id} ${run.title} · ${formatElapsed(run.elapsedMs)}`,
        width,
      ),
    );
  }
  const hidden = active.length - roomForRows;
  if (hidden > 0) lines.push(fitLine(`… ${hidden} more running`, width));
  return lines;
}
