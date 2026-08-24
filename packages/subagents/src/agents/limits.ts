/**
 * Fixed limits for named-agent discovery and saved routing (SPEC.md
 * "Named-agent discovery" and "Security and bounds"). Every scan, parse,
 * warning, and model-visible string in src/agents/** is bounded by one of
 * these constants. They are deliberately plain numbers, not options: the SPEC
 * calls for fixed limits, and fixed limits keep the behavior predictable
 * across scopes.
 */

/** Max `pi.subagents.agents` directory declarations honored per package. */
export const MAX_MANIFEST_AGENT_DIRS = 8;

/** Max recursion depth below a scan root (root itself is depth 0). */
export const MAX_SCAN_DEPTH = 5;

/** Max directories visited across one whole discovery pass. */
export const MAX_SCAN_DIRECTORIES = 128;

/** Max agent Markdown files read across one whole discovery pass. */
export const MAX_SCAN_FILES = 256;

/** Max size of a single agent definition file. */
export const MAX_AGENT_FILE_BYTES = 128 * 1024;

/** Max aggregate bytes read across one whole discovery pass. */
export const MAX_SCAN_TOTAL_BYTES = 1024 * 1024;

/** Max size of a package.json read for manifest extraction. */
export const MAX_PACKAGE_JSON_BYTES = 256 * 1024;

/** Bounds on discovered agent metadata. */
export const MAX_AGENT_NAME_CHARS = 64;
export const MAX_AGENT_DESCRIPTION_CHARS = 500;
export const MAX_AGENT_MODEL_CHARS = 200;
export const MAX_AGENT_TOOLS = 64;
export const MAX_AGENT_TOOL_NAME_CHARS = 100;
export const MAX_AGENT_SKILLS = 32;
export const MAX_AGENT_SKILL_NAME_CHARS = 100;
export const MAX_SYSTEM_PROMPT_CHARS = 32 * 1024;

/** Agent, tool, and skill names must be short, path-safe identifiers. */
export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const AGENT_TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const AGENT_SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Bounds on diagnostics. */
export const MAX_WARNINGS = 25;
export const MAX_WARNING_CHARS = 300;

/** Max size of a subagents.json routing file. */
export const MAX_ROUTING_FILE_BYTES = 64 * 1024;

/** Max routing-entry model string length. */
export const MAX_ROUTING_MODEL_CHARS = 200;

/** Max attempts to find a free backup filename for an invalid routing file. */
export const MAX_BACKUP_ATTEMPTS = 20;
