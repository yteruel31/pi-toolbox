import type { HarnessKind } from "../shared/types.js";

const PI_NATIVE_TOOLS: ReadonlySet<string> = new Set(["read", "grep", "find", "ls", "bash", "powershell", "edit", "write"]);
const CLAUDE_NATIVE_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch"]);

/** Categorical diagnostic; never echoes tool names. */
export const TOOL_DIALECT_CONFLICT = "The tool allowlist uses another backend's native tool names. Check the profile tools and harness mapping.";

/**
 * Deterministic cross-backend guard shared by Jev and configured routing.
 * An allowlist restricts tools; it does not require every entry to exist, so
 * unknown extension names never disqualify a backend. Only native tool names
 * of the other backend prove the allowlist was written for that backend.
 */
export function toolsCompatible(harness: HarnessKind, tools: readonly string[] | undefined): boolean {
  if (!tools) return true;
  const otherBackend = harness === "pi" ? CLAUDE_NATIVE_TOOLS : PI_NATIVE_TOOLS;
  return tools.every((tool) => !otherBackend.has(tool));
}
