# Changelog

## [Unreleased]

### Added
- Initial lifecycle-idle Pi extension package.
- Typed, fail-soft configuration loading and validation for the future MCP Apps gateway.
- On-demand private singleton gateway foundation and non-destructive Tailscale Serve setup, doctor, and confirmed removal commands.
- Lazy Streamable HTTP, legacy SSE, and trusted-command stdio MCP clients with status, capability-aware bounded pagination, tool/resource/prompt discovery, resource reads, prompt retrieval, search, refresh, and bounded calls.
- Interactive OAuth authorization with private persisted credentials and an ephemeral callback-only gateway session.
- Lazy loopback MCP App host with exact `ui://` resource loading, official bundled AppBridge, sandbox/CSP enforcement, consented same-server tool calls, replayable SSE, and heartbeat-based session expiry.
- Lazy private publication of active Apps through a verified Tailscale Serve route, with an identity-gated dashboard, capability proxy, persistent Pi status link, and fail-closed gateway protocol v2.
- Configurable global/per-server direct Pi tools for discovered model-visible MCP tools, with collision-safe aliases, shared bounded execution, and session/refresh lifecycle deactivation.
- Consent-gated text-only MCP sampling and bounded interactive form elicitation, with accurate client capabilities, cancellation, and no automatic URL opening.
