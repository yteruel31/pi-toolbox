# pi-mcp

Private Tailnet MCP Apps gateway for Pi. The package connects Streamable HTTP, legacy SSE, and stdio MCP servers, hosts Apps on loopback, and lazily publishes active sessions through the configured Tailscale Serve route with a private dashboard and persistent Pi status link.

## Configuration contract

Configuration is read in order from `~/.config/mcp/mcp.json`, then `~/.pi/agent/mcp.json`. Server entries are merged by name; the Pi layer replaces matching entries. Its valid UI fields augment the lower layer. Missing and invalid files fail safely with structured, value-free diagnostics.

```json
{
  "mcpServers": {
    "example": { "url": "https://example.invalid/mcp", "directTools": ["search", "read"] }
  },
  "settings": {
    "directTools": false,
    "ui": {
      "hostname": "auto",
      "httpsPort": 8443,
      "basePath": "/mcp-ui",
      "gatewayPort": 19877,
      "requireTailscaleIdentity": true,
      "idleTimeoutMs": 300000
    },
    "sampling": true,
    "samplingAutoApprove": false,
    "elicitation": true
  }
}
```

URL definitions may explicitly select `streamable-http` or legacy `sse`; when omitted, Pi tries Streamable HTTP and falls back to SSE only when the modern endpoint is unsupported. Stdio definitions use `{ "command": "executable", "args": [], "env": {}, "cwd": "..." }`. Commands are spawned directly without a shell. Configured stdio commands execute trusted local code with the user's privileges; only configure commands you trust. Configuration values and child stderr are never exposed in model-visible errors. `idleTimeoutMs` must be between 15 seconds and 24 hours so capability heartbeats and bounded gateway operations can complete before lease expiry.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

## Private gateway (U2)

`/mcp-gateway setup` persistently adds only the configured Tailscale Serve HTTPS path; existing Serve routes are retained. `/mcp-gateway doctor` reports local gateway/config, hostname, and route state. `/mcp-gateway remove [--yes]` removes only an exactly matching route and asks for confirmation unless `--yes` is supplied. The gateway starts on demand, binds its public listener to `127.0.0.1`, and uses private capability URLs; loading the extension starts no service.

## MCP transports and tools (U3a/U5)

The lazy `mcp` tool reports server status, connects or refreshes one server, lists and searches tools, and invokes tools by unique original name or stable `<server>_<tool>` alias. Set `settings.directTools` to `true` to expose discovered model-visible tools directly to Pi, or override each server with `directTools: true`, `false`, or a unique bounded array of original tool names. Direct tools use the MCP input schema and the same bounded, abort-aware result/App path as `mcp`; App-only tools are never exposed directly. Opted-in servers may connect in the background at session start, while the extension remains network-idle when direct tools are disabled. It also provides capability-aware resource and prompt operations: `resources-list`, `resources-read`, `prompts-list`, and `prompts-get`, each explicitly qualified by `server`. Discovery is paginated and bounded; unsupported server capabilities are never queried. Unexpected transport closes reconnect before the next operation, while ambiguous tool/resource/prompt requests are never replayed. Advertised list-change notifications refresh metadata serially and preserve the last known list on transient failure. Successful metadata is cached in private mode `0600` records below the mode `0700` directory `~/.pi/agent/pi-mcp/metadata/`; cache hydration can expose configured direct tools before networking but never reports a server as connected. Run `mcp({ action: "diagnostics" })` (optionally with `server`) for bounded value-free states, metadata/cache status, and lifecycle counters. Only HTTPS endpoints and literal loopback HTTP endpoints are accepted. OAuth-protected HTTP and SSE servers reuse stored tokens when possible; OAuth is unavailable for stdio.

## Sampling and elicitation (U8)

Interactive sessions advertise conservative MCP sampling and form elicitation unless disabled with `settings.sampling: false` or `settings.elicitation: false`. Every sampling request shows a bounded preview and requires approval both before provider use and before returning the answer. Headless sampling is disabled unless `samplingAutoApprove: true` is explicitly configured. Requests, outputs, schemas, concurrency, and model token budgets are bounded; unsupported tool use, context inclusion, non-text sampling, and unsafe form schemas fail closed.

Form elicitation supports bounded strings, choices, numbers, integers, booleans, and string arrays, followed by a local review. Collected values are returned only to the requesting MCP server and are not added to model-visible details. URL elicitation is not advertised or supported, and the package never opens a browser automatically.

## OAuth (U3b)

Run `/mcp-gateway setup` first. Start an interactive flow with `mcp({ action: "auth-start", server: "example" })`, then open or copy the returned authorization URL; Pi never opens a browser automatically. The remote callback normally completes the flow. If it cannot, copy the complete browser redirect URL into `mcp({ action: "auth-complete", server: "example", args: { redirectUrl: "…" } })`.

OAuth credentials, PKCE material, and dynamic client registration are sensitive. They are stored as mode `0600` JSON below the private mode `0700` directory `~/.pi/agent/pi-mcp/oauth/`. Delete that directory to revoke Pi's local saved credentials (and revoke the provider-side grant separately when needed). Each authorization attempt receives a dedicated short-lived callback-only gateway capability; it does not grant MCP tool access.

## Local MCP App host (U4a)

Tools declaring `_meta.ui.resourceUri` (or the legacy `_meta["ui/resourceUri"]`) can return an MCP App. After a successful tool call, Pi reads the exact `ui://` resource, validates and bounds its HTML and metadata, and creates an isolated short-lived App session on a lazy `127.0.0.1` server. The normal tool result remains visible even if App loading fails.

The host uses the official bundled AppBridge, initializes it before loading an opaque sandboxed iframe, asks for browser consent before the first App-initiated tool call, scopes those calls to the owning MCP server, and records bounded message/context intents for later Pi integration. Sessions use heartbeat-based expiry, persistent replayable SSE, strict CSP/permissions, a process-private backend secret, and no automatic opening of the App UI. Explicit App `openLink` requests are validated, recorded, and delegated to the browser with `noopener,noreferrer`. Local backend origins, secrets, and routes are not included in model-visible tool details.

## Private App publication (U4b)

Run `/mcp-gateway setup` explicitly before using Apps. The first active App verifies (but never mutates) the exact Serve route, obtains one process-local capability, and publishes a bounded dashboard; concurrent Apps remain isolated below its proxy. Gateway protocol v2 fails closed against an older resident daemon; if one is still draining after an upgrade, wait for its idle shutdown before retrying. Tailscale identity is required by default. The capability is removed when the last App completes or expires, and the compact Pi status link is cleared. Pi startup remains resource-idle, no browser is opened, and capability URLs and backend credentials never enter model-visible results.
