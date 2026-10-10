---
"@yteruel31/pi-web-access": patch
---

Allow cache and report publication on Windows by skipping unsupported directory `fsync` calls while retaining atomic file publication. Keep Unix permission assertions scoped to platforms that expose Unix mode bits.
