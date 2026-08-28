import { formatRunIdentity } from "../shared/run-identity.js";
import { isSettledStatus } from "../shared/types.js";
import type { RunListEntry } from "../shared/types.js";
import { fitLine, formatElapsed, statusGlyph } from "./text.js";

export interface RunCounts {
  /** queued + running */
  running: number;
  completed: number;
  /** failed + cancelled */
  error: number;
}

export function countRuns(runs: readonly RunListEntry[]): RunCounts {
  const counts: RunCounts = { running: 0, completed: 0, error: 0 };
  for (const run of runs) {
    if (!isSettledStatus(run.status)) counts.running += 1;
    else if (run.status === "completed") counts.completed += 1;
    else counts.error += 1;
  }
  return counts;
}

/** Persistent compact discovery/status line, cleared only when no runs exist. */
export function statusText(runs: readonly RunListEntry[]): string | undefined {
  if (runs.length === 0) return undefined;
  const counts = countRuns(runs);
  return fitLine(
    `● ${counts.running} running · ✓ ${counts.completed} completed · × ${counts.error} error · /subagents`,
    100,
  );
}

export interface WidgetOptions {
  width: number;
  /** Max run rows before older/settled rows collapse into a count line. */
  maxLines: number;
}

/** Optional active-run widget retained for API compatibility. */
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
    lines.push(fitLine(
      `${statusGlyph(run.status)} ${run.id} ${formatRunIdentity(run)} · ${formatElapsed(run.elapsedMs)}`,
      width,
    ));
  }
  const hidden = active.length - roomForRows;
  if (hidden > 0) lines.push(fitLine(`… ${hidden} more running`, width));
  return lines;
}
