/**
 * Minimal YAML-frontmatter parser for agent definition files.
 *
 * Agent files only need flat, single-line scalar keys (SPEC.md
 * "Named-agent discovery"), so this parser deliberately supports exactly
 * that subset instead of pulling in a YAML dependency:
 *
 *   ---
 *   name: reviewer
 *   description: Review changes.
 *   harness: pi
 *   ---
 *   body…
 *
 * Unknown keys and non-scalar lines (indented continuations, list items,
 * comments) are ignored, so an agent file that carries extra YAML the loader
 * does not understand still parses as long as the keys we need are flat
 * scalars. Missing/invalid required keys are the caller's concern.
 */

export interface ParsedAgentMarkdown {
  /** Flat scalar frontmatter keys; last duplicate wins, YAML-style. */
  frontmatter: Record<string, string>;
  /** Markdown body after the closing delimiter, trimmed. */
  body: string;
}

const OPEN_DELIMITER = /^---\s*$/;
const CLOSE_DELIMITER = /^(---|\.\.\.)\s*$/;
const KEY_VALUE = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/;

export type FrontmatterResult =
  | { ok: true; parsed: ParsedAgentMarkdown }
  | { ok: false; reason: string };

export function parseAgentMarkdown(text: string): FrontmatterResult {
  // Tolerate a UTF-8 BOM, nothing else, before the opening delimiter.
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || !OPEN_DELIMITER.test(lines[0] ?? "")) {
    return { ok: false, reason: "missing frontmatter opening '---'" };
  }

  const frontmatter: Record<string, string> = {};
  let closedAt = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (CLOSE_DELIMITER.test(line)) {
      closedAt = i;
      break;
    }
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // Only flat, unindented scalars are meaningful to us.
    if (line !== line.trimStart()) continue;
    const match = KEY_VALUE.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    frontmatter[key] = unquote((match[2] ?? "").trim());
  }
  if (closedAt < 0) {
    return { ok: false, reason: "frontmatter is never closed with '---'" };
  }

  return {
    ok: true,
    parsed: {
      frontmatter,
      body: lines.slice(closedAt + 1).join("\n").trim(),
    },
  };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first)) {
      return value.slice(1, -1);
    }
  }
  return value;
}
