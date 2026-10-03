# Changelog

## Unreleased

- Add `/subagents background` to release all active model-facing waits without cancelling children, the parent, or sibling tools. Wait-release guidance distinguishes user steering from background acknowledgement, and the status slot now also shows live waiting/busy/available parent state while preserving its aggregate event counts.

- Clarify the parent workflow in tool guidance and the distributed skill: spawn bounded independent work, do useful parent work, collect relevant ready results once at a dependency boundary, and wait only for required ids. Guidance distinguishes headless required-result waits from interactive/RPC yielding and prohibits polling or artificial keepalive.

- Add per-field `auto` and `inherit` routing modes for harness, model, and thinking/effort in spawn arguments, saved routing, and profile frontmatter. `auto` delegates the field to Jev over lower fixed values and resolves as `inherit` when Jev is off or unavailable. `inherit` uses parent Pi values or Claude SDK defaults and no longer stops Jev from routing other free fields. Only the exact bare lowercase strings are reserved, and the routing editor now labels absent fields `unset`.
- Require Pi 0.87.1 and Claude Agent SDK 0.3.281 so routing sees the current model catalogues, including GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5.
- Enrich Jev candidate descriptions with each catalogue's max output and accepted input plus the Claude SDK's adaptive-thinking flag, prefer the Claude SDK's own model description, and resolve `[1m]` long-context aliases.
- Refresh the curated Jev purpose descriptions for GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5; a model with no curated entry is still described from runtime metadata alone.
- Show each run's thinking level after its model in interactive and headless run views and structured inspection output.
- Show the selected named-agent profile beside custom run titles in spawn transcript headings and run views, and preserve it across session reloads.

## 0.1.0

- Independent clean-room implementation of background Pi and Claude subagents.
