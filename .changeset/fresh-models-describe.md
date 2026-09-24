---
"@yteruel31/pi-subagents": minor
---

Require Pi 0.87.1 and Claude Agent SDK 0.3.281 so routing sees the current model catalogues, including GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5. Jev candidate descriptions now carry each catalogue's max output and accepted input and the Claude SDK's adaptive-thinking flag, and resolve `[1m]` long-context aliases. Curated purpose text is now only a fallback for a catalogue row that reports no description of its own, so the Claude SDK's own description always wins; the fallback table gains refreshed entries for GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5, and a model it doesn't cover is described from runtime metadata alone.
