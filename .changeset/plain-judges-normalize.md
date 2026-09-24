---
"@yteruel31/pi-guardrails": patch
---

Fold the judge instructions into the request transcript with Pi's `normalizeContext`, so a provider that reads transcript messages only still receives them. Declare the resulting Pi minimum: `normalizeContext` became a public `@earendil-works/pi-ai` export in 0.86.0, so the `@earendil-works/pi-ai` and `@earendil-works/pi-coding-agent` peer ranges move from `*` to `>=0.86.0`. Tested against Pi 0.87.1.
