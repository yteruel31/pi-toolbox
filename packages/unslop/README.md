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

## Inspiration

Inspired by [theclaymethod/unslop](https://github.com/theclaymethod/unslop). This package is an independent Pi prompt-guidance extension: it does not include or invoke a `SKILL.md`, claim compatibility, or copy upstream scanner guarantees.

## License

MIT
