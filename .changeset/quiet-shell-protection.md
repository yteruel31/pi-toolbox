---
"@yteruel31/pi-guardrails": patch
---

Stop treating shell mentions of guardrails as configuration mutation. Check literal mutation destinations against canonical protected paths, preserve read-only searches and quoted data, and require human review for shell effects outside the bounded classifier.
