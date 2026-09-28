---
"@yteruel31/pi-subagents": minor
---

Add per-field `auto` and `inherit` routing modes for harness, model, and thinking/effort in spawn arguments, saved routing, and profile frontmatter. `auto` delegates the field to Jev over lower fixed values and resolves as `inherit` when Jev is off or unavailable. `inherit` uses parent Pi values or Claude SDK defaults and no longer stops Jev from routing other free fields. Only the exact bare lowercase strings are reserved, so ids such as `openrouter/auto` stay literal.
