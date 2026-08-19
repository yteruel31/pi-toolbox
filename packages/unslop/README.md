# @yteruel31/pi-unslop

A Pi extension that adds concise, always-on **best-effort prompt guidance** for clearer prose and can learn a reusable writing voice.

It does not scan, rewrite, retry, or verify model output, and makes no deterministic enforcement claim. The policy applies to prose while preserving code, quoted/verbatim text, required formats, facts, uncertainty, and the language/register requested by the user.

## Install

```bash
pi install npm:@yteruel31/pi-unslop
```

## Teach a voice

In Pi's interactive TUI, run:

```text
/unslop teach
/unslop teach Editorial
```

Unslop asks for writing samples, then sends them as a user message to the current model for one synthesis run. The samples therefore remain in the current Pi session. Only the derived, validated profile is written to Pi's environment-aware global agent directory under `unslop/voice.json`; raw samples are never written to the Unslop profile store or harvested from files, folders, or transcripts.

The taught voice is automatically included in later system prompts across projects. Teaching again replaces the global profile atomically. The `UNSLOP` status uses Pi's normal extension status API, so it works with or without `@yteruel31/pi-ui-customization`.

## Refine a voice privately

After teaching a profile, run:

```text
/unslop refine
```

Refine improves that single global profile; it never creates one from scratch. If no profile exists, Unslop directs you to `/unslop teach` without scanning sessions or invoking the model.

Unslop uses Pi's public session API to inspect only a conservative, newest-first bound of recent sessions across projects. It considers only user-authored text on each active branch and rejects commands, short or oversized messages, likely secrets, large pastes/code blocks, summaries, tools, assistant/custom content, and Unslop control prompts. It reads at most 12 session files, accepts at most 12 messages of at most 4,000 characters each, and submits at most 12,000 characters total. Filtering is deliberately conservative and best effort; Unslop never scans arbitrary files or folders and performs no background or unlimited transcript scan.

Before model submission, a first confirmation displays the exact candidate excerpts. They remain only in extension memory: the persisted user trigger is generic and contains no excerpts, while a one-shot system instruction supplies them for that turn and is then cleared. Raw excerpts are not written to the Unslop store or current Pi session. A second confirmation visibly compares the existing and candidate profiles before replacement. Cancelling either confirmation preserves the existing profile. Only an accepted, validated derived profile is stored atomically with restrictive permissions, and its existing profile name is preserved.

Typing `/unslop ` offers native argument discovery for `teach` and `refine`, including descriptions and case-insensitive prefix filtering.

## Inspiration

Inspired by [theclaymethod/unslop](https://github.com/theclaymethod/unslop). This package is an independent Pi prompt-guidance extension: it does not include or invoke a `SKILL.md`, claim compatibility, or copy upstream scanner guarantees.

## License

MIT
