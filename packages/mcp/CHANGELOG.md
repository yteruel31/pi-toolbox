# Changelog

## [Unreleased]

Phase 2 is implemented for the approved Mobbin/Tailnet scope. This release does not claim universal `pi-mcp-adapter` parity; see `PARITY.md` for gaps and migration guidance.

### Fixed
- Adapter-compatible OAuth/lazy server definitions remain valid in `/mcp`, while actions on unsupported definitions now explain why they cannot run.

### Added
- `/mcp` TUI management panel with live server/tool search, enable/disable, direct-tool selection, reconnect, OAuth start, safe global config persistence, and a compact below-editor MCP status indicator.
- Control-only `disabled`/`directTools` server overlays in `~/.pi/agent/mcp.json`, avoiding transport or credential duplication from the lower config layer.
- Initial lifecycle-idle Pi extension package.
- Typed, fail-soft configuration loading and validation for the future MCP Apps gateway.
- On-demand private singleton gateway foundation and non-destructive Tailscale Serve setup, doctor, and confirmed removal commands.
- Lazy Streamable HTTP, legacy SSE, and trusted-command stdio MCP clients with status, capability-aware bounded pagination, tool/resource/prompt discovery, resource reads, prompt retrieval, search, refresh, and bounded calls.
- Interactive OAuth authorization with private persisted credentials and an ephemeral callback-only gateway session.
- Lazy loopback MCP App host with exact `ui://` resource loading, official bundled AppBridge, sandbox/CSP enforcement, consented same-server tool calls, replayable SSE, and heartbeat-based session expiry.
- Lazy private publication of active Apps through a verified Tailscale Serve route, with an identity-gated dashboard, capability proxy, persistent Pi status link, and fail-closed gateway protocol v2.
- Configurable global/per-server direct Pi tools for discovered model-visible MCP tools, with collision-safe aliases, shared bounded execution, and session/refresh lifecycle deactivation.
- Consent-gated text-only MCP sampling and bounded interactive form elicitation, with accurate client capabilities, cancellation, and no automatic URL opening.
- Resilient MCP reconnects and bounded list-change refreshes, private metadata caching for immediate direct tools, and value-free diagnostics.
- Executable `check:conformance` coverage for the named Phase-2 protocol, OAuth, Apps, publication, cache, diagnostics, and lifecycle scenarios.
- An explicit `pi-mcp-adapter` 2.15 parity matrix and acceptance-first Mobbin/Tailnet migration runbook.
