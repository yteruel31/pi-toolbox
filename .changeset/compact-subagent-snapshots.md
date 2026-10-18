---
"@yteruel31/pi-subagents": patch
---

Replace cumulative inline session snapshots with compact v2 checkpoints and private content-addressed transcript/result chunks. Restore legacy v1 state without rewriting its payloads into new entries, retain consumed results, and fail closed on storage errors with retryable consumption commits.
