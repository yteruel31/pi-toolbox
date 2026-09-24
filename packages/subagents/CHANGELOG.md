# Changelog

## Unreleased

- Require Pi 0.87.1 and Claude Agent SDK 0.3.281 so routing sees the current model catalogues, including GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5.
- Enrich Jev candidate descriptions with each catalogue's max output and accepted input plus the Claude SDK's adaptive-thinking flag, prefer the Claude SDK's own model description, and resolve `[1m]` long-context aliases.
- Refresh the curated Jev purpose descriptions for GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5; a model with no curated entry is still described from runtime metadata alone.
- Show each run's thinking level after its model in interactive and headless run views and structured inspection output.
- Show the selected named-agent profile beside custom run titles in spawn transcript headings and run views, and preserve it across session reloads.

## 0.1.0

- Independent clean-room implementation of background Pi and Claude subagents.
