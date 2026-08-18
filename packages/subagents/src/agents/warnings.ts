/**
 * Bounded, deduplicated warning collector for discovery diagnostics.
 * Each warning is truncated, duplicates are dropped, and once the cap is
 * reached further warnings collapse into a single suppression marker so the
 * model-visible list can never grow without bound.
 */

import { truncateText } from "../shared/truncate.js";
import { MAX_WARNING_CHARS, MAX_WARNINGS } from "./limits.js";

export class WarningCollector {
  private readonly seen = new Set<string>();
  private suppressed = 0;

  constructor(
    private readonly maxWarnings = MAX_WARNINGS,
    private readonly maxChars = MAX_WARNING_CHARS,
  ) {}

  add(message: string): void {
    const bounded = truncateText(message, this.maxChars);
    if (this.seen.has(bounded)) return;
    if (this.seen.size >= this.maxWarnings) {
      this.suppressed++;
      return;
    }
    this.seen.add(bounded);
  }

  list(): string[] {
    const out = [...this.seen];
    if (this.suppressed > 0) {
      out.push(
        truncateText(`… ${this.suppressed} additional warnings suppressed`, this.maxChars),
      );
    }
    return out;
  }
}
