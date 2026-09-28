---
"@yteruel31/pi-subagents": patch
---

Fix Jev rejecting a fixed full Claude model id that the SDK's discovered catalogue lists only through aliases. The id is kept exactly as written for the Claude SDK to validate, without a Jev call and with a bounded routing warning. It is never swapped for an alias with a different resolved identity, and tool, harness, and empty-catalogue conflicts still fail.
