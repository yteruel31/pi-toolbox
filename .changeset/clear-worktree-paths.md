---
"@yteruel31/pi-guardrails": patch
---

Preserve ordinary long filesystem paths during assessment and history sanitization instead of mistaking slash-separated directories for opaque credentials. Keep credential masking and restrictive policies intact, and explicitly require review when cwd or target metadata is still incomplete.
