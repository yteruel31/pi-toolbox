# Changelog

## Unreleased

Add five web-access tools with explicit search providers, local content extraction, bounded storage, model-assisted source checks, and recoverable native deep research saved to Markdown.

Support opt-in Linux Secret Service credentials through `keyring:pi-web-access/<provider>` references, with bounded helper calls and no credential fallback.

Add opt-in authenticated Reddit search and bounded post/comment reads through an explicitly configured private native-browser profile, with local-only readiness inspection, explicit two-request validation, persisted identity-bound readiness, reload-stable tool registration, and a dedicated Diagnostic view. Same-profile operations from tools and sessions use a cancellable bounded queue (120-second wait, 16 pending per process/profile), with FIFO ordering in-process and cross-process exclusion. Transient busy and HTTP failures preserve cached readiness and render separately from explicit test outcomes. Reddit access uses native Chromium sandbox checks, Xvfb, strict request/route controls, private profile locking, and no profile discovery, cookie export, automatic login, pagination, stale-lock deletion, or retry.

<!-- AI generated -->
