---
name: knowledge-capture
description: Create or update durable Markdown knowledge notes in roots configured for @yteruel31/pi-context. Use when the user asks to save something to knowledge, or when a stable reusable procedure, decision, architecture explanation, or troubleshooting result is worth proposing for capture.
metadata:
  short-description: Capture durable knowledge with confirmation
---

# Knowledge capture

Capture reusable knowledge in the Markdown roots configured in `~/.pi/agent/context/config.json`.

## Authorization gate

- A direct request such as “add this to knowledge” authorizes the write described by that request.
- For proactive capture, explain in one sentence what is worth preserving and ask for explicit confirmation with `ask_user` before writing.
- Never write after a declined, cancelled, or ambiguous confirmation.
- Keep the bar high. Do not propose capturing transient progress, routine command output, speculative ideas, or facts already represented well as a short durable memory.

## Safety

- Never persist passwords, access tokens, private keys, raw credentials, session cookies, or credential-bearing URLs.
- Do not silently broaden the configured disclosure boundary. Write only inside an existing root listed in `knowledge.roots`.
- Use only an allowed extension from `knowledge.extensions`; prefer Markdown.
- Preserve unrelated user-authored content and the note's existing structure or frontmatter.

## Workflow

1. Read `~/.pi/agent/context/config.json`. If it is absent or has no knowledge roots, ask the user to configure a root with `/knowledge-search-setup`.
2. Distill the durable content before editing. Keep evidence, constraints, decisions, and operational steps; remove conversational filler and unsupported conclusions.
3. Search for an existing note with `knowledge_search`. Also inspect likely files in the configured roots because newly edited files may not be indexed yet.
4. Update the most specific existing note when the topic already has a clear home. Otherwise choose a descriptive lowercase hyphenated filename. Ask the user when multiple materially different locations are plausible.
5. Use clear headings and include the topic's important terms in the note body so lexical FTS5 search can find it. Add dates only when recency matters.
6. Read back the changed section and verify that no secret or unrelated content was introduced.
7. Tell the user exactly which file changed. Ask them to run `/knowledge-refresh` to incrementally update the active knowledge index. Do not claim the index was refreshed unless that command completed successfully.

## Writing style

Write concise reference material rather than a transcript. Prefer:

- a descriptive `#` title;
- short context explaining when the note applies;
- concrete decisions, commands, constraints, and verification steps;
- links to related notes when useful.

Do not impose frontmatter on an existing collection that does not use it.
