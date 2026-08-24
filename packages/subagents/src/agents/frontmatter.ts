import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Backward-compatible frontmatter parser for agent definition files.
 *
 * Existing agent keys retain the original flat-scalar behavior: unknown nested
 * YAML is ignored and duplicate scalars use the last value. The `skills` node
 * alone is then parsed with normal YAML semantics so Claude-compatible block
 * and flow sequences work without changing legacy handling elsewhere:
 *
 *   skills:
 *     - code-review
 *     - security
 *
 *   skills: [code-review, security]
 *
 * Missing/invalid required keys remain the discovery validator's concern.
 */

export interface ParsedAgentMarkdown {
  frontmatter: Record<string, unknown>;
  /** Markdown body after the closing delimiter, trimmed. */
  body: string;
}

const OPEN_DELIMITER = /^---\s*$/;
const CLOSE_DELIMITER = /^(---|\.\.\.)\s*$/;
const KEY_VALUE = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/;
const SKILLS_KEY = /^skills:(?:\s|$)/;
const INVALID_SKILLS_YAML = "[invalid skills YAML";

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

  let closedAt = -1;
  for (let index = 1; index < lines.length; index++) {
    if (CLOSE_DELIMITER.test(lines[index] ?? "")) {
      closedAt = index;
      break;
    }
  }
  if (closedAt < 0) {
    return { ok: false, reason: "frontmatter is never closed with '---'" };
  }

  const yamlLines = lines.slice(1, closedAt);
  const frontmatter: Record<string, unknown> = {};
  for (const line of yamlLines) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    // Preserve the original flat, unindented scalar parser for compatibility.
    if (line !== line.trimStart()) continue;
    const match = KEY_VALUE.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    frontmatter[key] = unquote((match[2] ?? "").trim());
  }

  const skills = parseLastSkillsDeclaration(yamlLines);
  if (skills.present) frontmatter.skills = skills.value;

  return {
    ok: true,
    parsed: {
      frontmatter,
      body: lines.slice(closedAt + 1).join("\n").trim(),
    },
  };
}

function parseLastSkillsDeclaration(
  lines: readonly string[],
): { present: false } | { present: true; value: unknown } {
  let declaration: string[] | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line !== line.trimStart() || !SKILLS_KEY.test(line)) continue;

    const collected = [line];
    for (let nested = index + 1; nested < lines.length; nested++) {
      const candidate = lines[nested] ?? "";
      if (
        candidate.trim() !== "" &&
        candidate === candidate.trimStart() &&
        !/^[-\]},]/.test(candidate)
      ) break;
      collected.push(candidate);
    }
    declaration = collected;
  }
  if (!declaration) return { present: false };

  try {
    const value = parseFrontmatter<{ skills?: unknown }>(
      `---\n${declaration.join("\n")}\n---`,
    ).frontmatter.skills;
    // An empty `skills:` declaration is equivalent to an empty preload list.
    return { present: true, value: value ?? [] };
  } catch {
    // Let normal skills validation reject only this agent definition.
    return { present: true, value: INVALID_SKILLS_YAML };
  }
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
