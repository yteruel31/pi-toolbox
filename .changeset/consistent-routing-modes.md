---
"@yteruel31/pi-subagents": patch
---

Make routing modes behave consistently with and without Jev. An inherited model no longer switches silently to the Claude SDK default when fixed thinking isn't supported by the parent Pi model. Native tool names from the other backend are rejected before any backend starts, instead of starting it with no usable tools. A harness `auto` falls back like `inherit` while keeping a fixed model unchanged. Fallback validates only literal thinking, not inherited parent thinking. Saved and spawn model values are trimmed like profile values. The routing panel labels unresolved harness modes.
