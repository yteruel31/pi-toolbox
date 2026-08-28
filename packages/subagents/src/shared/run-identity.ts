import { sanitizeTerminalText, toDisplayTitle } from "./truncate.js";
import type { RunInspection, RunListEntry, RunResult, RunSnapshot } from "./types.js";

type RunIdentity = Pick<RunSnapshot | RunResult | RunListEntry | RunInspection, "title" | "agentProfile">;

/** Human-facing identity without changing the run's stored display title. */
export function formatRunIdentity(run: RunIdentity): string {
  return run.agentProfile ? `${run.title} (${run.agentProfile})` : run.title;
}

/** Bounded one-line identity suffix for the collapsed spawn tool call. */
export function formatSpawnCallIdentity(input: { name?: unknown; agent?: unknown }): string {
  const name = typeof input.name === "string"
    ? toDisplayTitle(sanitizeTerminalText(input.name))
    : "";
  const agent = typeof input.agent === "string"
    ? toDisplayTitle(sanitizeTerminalText(input.agent))
    : "";
  if (name && agent) return ` ${name} (${agent})`;
  if (name) return ` ${name}`;
  if (agent) return ` (${agent})`;
  return "";
}
