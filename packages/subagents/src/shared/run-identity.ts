import type { RunInspection, RunListEntry, RunResult, RunSnapshot } from "./types.js";

type RunIdentity = Pick<RunSnapshot | RunResult | RunListEntry | RunInspection, "title" | "agentProfile">;

/** Human-facing identity without changing the run's stored display title. */
export function formatRunIdentity(run: RunIdentity): string {
  return run.agentProfile ? `${run.title} (${run.agentProfile})` : run.title;
}
