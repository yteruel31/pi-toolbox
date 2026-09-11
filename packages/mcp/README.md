# @yteruel31/pi-mcp

MCP client and capability gateway for Pi.

```bash
pi install npm:@yteruel31/pi-mcp
```

The package connects Streamable HTTP, legacy SSE, and stdio MCP servers, hosts Apps on loopback, and lazily publishes active sessions through either managed Tailscale Serve or a user-managed HTTPS reverse proxy, with a dashboard and persistent Pi status link. It is not a universal `pi-mcp-adapter` replacement; see the [parity matrix and migration runbook](./PARITY.md).

## Configuration contract

Configuration is read in order from `~/.config/mcp/mcp.json`, then `~/.pi/agent/mcp.json`. Server entries are merged by name. A Pi entry containing `url` or `command` replaces the matching definition; an entry containing only `disabled` and/or `directTools` is a targeted control overlay, so the panel never needs to copy a lower-layer transport, headers, environment, or credentials. Valid UI fields augment the lower layer. Missing and invalid files fail safely with structured, value-free diagnostics.

```json
{
  "mcpServers": {
    "example": {
      "url": "https://example.invalid/mcp",
      "disabled": false,
      "directTools": ["search", "read"]
    }
  },
  "settings": {
    "directTools": false,
    "gateway": {
      "mode": "custom",
      "externalUrl": "https://mcp.example.com/mcp-ui",
      "listenAddress": "127.0.0.1"
    },
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

`settings.gateway` is a Pi-owned global setting accepted only from `~/.pi/agent/mcp.json`; this ensures panel deactivation cannot be overridden by a lower layer. It is optional and has no implicit default: until `/mcp` or the validated `mcp` gateway action saves a configuration, OAuth callbacks and remote App publication remain disabled. The JSON above documents the stored format, not a setup procedure; don't write gateway settings directly. A custom `externalUrl` must be HTTPS without credentials, query, or fragment; its optional path is preserved. `listenAddress` must be an explicit IP literal agreed during setup; prefer `127.0.0.1` when the proxy can reach loopback.

URL definitions may explicitly select `streamable-http` or legacy `sse`; when omitted, Pi tries Streamable HTTP and falls back to SSE only when the modern endpoint is unsupported. Adapter-compatible `auth: "oauth"` and `lifecycle: "lazy"` markers are accepted because they match this runtime's OAuth discovery and lazy lifecycle. Bearer authentication helpers and non-lazy lifecycle modes remain unsupported and fail closed rather than being silently ignored. Stdio definitions use `{ "command": "executable", "args": [], "env": {}, "cwd": "..." }`; they may also include the compatible `lifecycle: "lazy"` marker. Add `disabled: true` to keep a server configured while preventing connection, discovery, and direct-tool registration. Commands are spawned directly without a shell. Configured stdio commands execute trusted local code with the user's privileges; only configure commands you trust. Configuration values and child stderr are never exposed in model-visible errors. `idleTimeoutMs` must be between 15 seconds and 24 hours so capability heartbeats and bounded gateway operations can complete before lease expiry.

## Development

```bash
npm install
npm run check
npm run check:conformance
npm run pack:dry
```

`check:conformance` verifies that the named Phase-2 scenarios remain present and runs real current MCP SDK protocol/transport, OAuth, Apps, gateway, cache, lifecycle, and package-manifest tests. It uses loopback and temporary files only. The normal `check` command includes it.

## MCP management panel

Run `/mcp` in TUI mode to open a compact, resizable modal with Servers, Gateway, and Diagnostics sections. Its frame, tabs, selected rows, and theme tokens follow the Subagents configuration UI without importing another package's internals or requiring full screen. `Tab` and `Shift+Tab` switch sections without dropping staged server changes. Gateway controls remain available whether publication is configured or not.

Servers shows live connection, OAuth, transport, and cached/discovered capability state; expands model-visible tools; searches servers and tools; reconnects servers; starts OAuth without opening a browser automatically; enables or disables servers; and stages per-server direct-tool selections. `Ctrl+S` writes only changed `disabled` and `directTools` fields to the Pi-owned global file `~/.pi/agent/mcp.json`, preserving unknown data and existing file permissions, then reloads Pi. Writes use a private lock plus optimistic change detection, retrying rather than silently replacing a concurrent update. An orphaned `mcp.json.lock` fails closed; remove it only after confirming that no Pi process is editing the configuration. `Esc` cancels without writing.

The footer uses the separate `mcp-status` slot to show a compact connected/enabled count and authentication or error totals. It updates on lifecycle transitions without connecting merely to calculate status. The existing `mcp-ui` slot remains reserved for the private MCP Apps publication link.

Alongside that slot, every status recomputation broadcasts the same aggregate on the `pi.events` channel `pi-toolbox:mcp:status` as `{ v: 1, counts: McpStatusCounts }` (`total`, `enabled`, `connected`, `authRequired`, `errors`, `disabled`). `{ v: 1, counts: null }` is emitted on session start before a new runtime exists and on shutdown, so consumers discard stale counts. This package keeps owning the `mcp-status` slot; the channel is advisory.

Server keys: `↑/↓` select, `Enter` expand, `Space` toggle a direct tool, `d` enable/disable, `r` reconnect, `a` authenticate, `/` search, `Ctrl+S` save, and `Esc` cancel. `g` switches to Gateway. When publication is unconfigured, `a` explains the requirement. Save staged server edits or cancel them before leaving the modal for gateway configuration or agent assistance.

## Gateway setup (U2)

Use `/mcp` > Gateway to configure, validate, or deactivate publication. There is no separate gateway slash command. The section offers two explicit modes and no automatic fallback:

- **Managed Tailscale** forces loopback listening and Tailscale identity checks, adds/removes only the exact configured Serve path, and preserves unrelated routes.
- **Custom** closes the modal and starts a conversation with the current agent. The prompt asks it to inspect existing infrastructure read-only, then ask about Traefik or another proxy, the domain, public/private access, and reusing or installing a proxy. Infrastructure changes require explicit agreement. After agreement, the agent can configure the proxy with its normal tools and call the validated gateway action below. The gateway service itself never installs, configures, or removes a custom proxy.

Both setup paths require interactive confirmation, quiesce this runtime's MCP connections and sessions, start a short-lived secret-protected backend, and require an exact random challenge through the external HTTPS capability URL before saving. The same serialized service owns UI and agent operations, daemon lifecycle, route ownership, rollback, and the locked atomic configuration writer. It restores the MCP runtime and direct-tool registry after maintenance without reloading the active agent session. A writer rejection after a verified commit doesn't undo the committed infrastructure. Failed rollback and runtime restoration are reported separately.

Local daemon reachability alone is never reported as success. Switching modes leaves previous external infrastructure untouched and reports that fact. Deactivation revokes this runtime's sessions; other active Pi leases block daemon shutdown. Custom deactivation clears only Pi's configuration. Tailscale removal touches only the exact matching route.

The gateway starts on demand and loading the extension starts no service. Custom non-loopback listening exposes cleartext capability endpoints on the selected interface; network access policy and reverse-proxy protection are the user's responsibility. Capability URLs remain random and short-lived, backend secrets stay loopback-only, and incoming Tailscale identity headers are ignored in custom mode.

### Diagnostics and current-agent repair

Diagnostics shows the failing step, an allowlisted cause, and a next action. It distinguishes route conflicts/absence, missing Tailscale, permissions, hostname lookup, incompatible/busy daemons, DNS, TLS, timeout, HTTP denial, missing paths, upstream errors, challenge mismatch, and persistence failure. Unknown failures stay generic. A 404 can mean a path mismatch or missing Tailscale identity, so the UI doesn't claim to know which one occurred.

`v` validates on demand. `f` (or Gateway > Ask current agent to repair) explicitly closes the modal and sends a safe contextual prompt to the current conversation. It queues a follow-up if the agent is busy. No repair is launched automatically. Reports and handoffs omit configured URLs, capability paths, credentials, raw errors, and command output. Diagnosis may lazily start a daemon and use an ephemeral challenge lease, but never changes proxy routes or saves settings.

### Validated agent configuration

```typescript
mcp({ action: "gateway-status" }) // No network; safe mode/state and local gateway port
mcp({ action: "gateway-validate" }) // External challenge, no persistence
mcp({ action: "gateway-configure", args: { mode: "tailscale" } })
mcp({ action: "gateway-configure", args: {
  mode: "custom",
  externalUrl: "https://mcp.example.com/mcp-ui",
  listenAddress: "127.0.0.1",
} })
mcp({ action: "gateway-deactivate" })
```

Gateway actions cannot be combined with server operations. Only `gateway-configure` accepts args. Mutations require a fresh `ctx.ui.confirm` in TUI or an interactive RPC client; print/JSON sessions cannot approve them. Cancellation is checked between bounded operations and before persistence, with rollback if needed. The tool returns structured `state`, `diagnostic`, `persisted`, `rollback`, and restoration information rather than unsafe exception text.

The proxy must preserve the base path when forwarding to the agreed IP and the port returned by `gateway-status`. Don't use interactive proxy authentication that blocks OAuth callbacks. Never disable TLS verification. Validation proves reachability from the Pi host, not from every remote browser; confirm the agreed public/private access policy separately. The Custom prompt is a guided conversation, not an automatic infrastructure installer or a sandbox for the agent's shell tools.

## MCP transports and tools (U3a/U5)

The lazy `mcp` tool reports server status, connects or refreshes one server, lists and searches tools, and invokes tools by unique original name or stable `<server>_<tool>` alias. Set `settings.directTools` to `true` to expose discovered model-visible tools directly to Pi, or override each server with `directTools: true`, `false`, or a unique bounded array of original tool names. Direct tools use the MCP input schema and the same bounded, abort-aware result/App path as `mcp`; App-only tools are never exposed directly. Opted-in servers may connect in the background at session start, while the extension remains network-idle when direct tools are disabled. It also provides capability-aware resource and prompt operations: `resources-list`, `resources-read`, `prompts-list`, and `prompts-get`, each explicitly qualified by `server`. Discovery is paginated and bounded; unsupported server capabilities are never queried. Unexpected transport closes reconnect before the next operation, while ambiguous tool/resource/prompt requests are never replayed. Advertised list-change notifications refresh metadata serially and preserve the last known list on transient failure. Successful metadata is cached in private mode `0600` records below the mode `0700` directory `~/.pi/agent/pi-mcp/metadata/`; cache hydration can expose configured direct tools before networking but never reports a server as connected. Run `mcp({ action: "diagnostics" })` (optionally with `server`) for bounded value-free states, metadata/cache status, and lifecycle counters. Only HTTPS endpoints and literal loopback HTTP endpoints are accepted. OAuth-protected HTTP and SSE servers reuse stored tokens when possible; OAuth is unavailable for stdio.

## Sampling and elicitation (U8)

Interactive sessions advertise conservative MCP sampling and form elicitation unless disabled with `settings.sampling: false` or `settings.elicitation: false`. Every sampling request shows a bounded preview and requires approval both before provider use and before returning the answer. Headless sampling is disabled unless `samplingAutoApprove: true` is explicitly configured. Requests, outputs, schemas, concurrency, and model token budgets are bounded; unsupported tool use, context inclusion, non-text sampling, and unsafe form schemas fail closed.

Form elicitation supports bounded strings, choices, numbers, integers, booleans, and string arrays, followed by a local review. Collected values are returned only to the requesting MCP server and are not added to model-visible details. URL elicitation is not advertised or supported, and the package never opens a browser automatically.

## OAuth (U3b)

Configure and externally validate a publication mode with `/mcp` > Gateway first. Start an interactive flow with `mcp({ action: "auth-start", server: "example" })`, then open or copy the returned authorization URL; Pi never opens a browser automatically. The remote callback normally completes the flow. If it cannot, copy the complete browser redirect URL into `mcp({ action: "auth-complete", server: "example", args: { redirectUrl: "…" } })`.

OAuth credentials, PKCE material, and dynamic client registration are sensitive. They are stored as mode `0600` JSON below the private mode `0700` directory `~/.pi/agent/pi-mcp/oauth/`. Delete that directory to revoke Pi's local saved credentials (and revoke the provider-side grant separately when needed). Each authorization attempt receives a dedicated short-lived callback-only gateway capability; it does not grant MCP tool access.

## Local MCP App host (U4a)

Tools declaring `_meta.ui.resourceUri` (or the legacy `_meta["ui/resourceUri"]`) can return an MCP App. After a successful tool call, Pi reads the exact `ui://` resource, validates and bounds its HTML and metadata, and creates an isolated short-lived App session on a lazy `127.0.0.1` server. The normal tool result remains visible even if App loading fails.

The host uses the official bundled AppBridge, initializes it before loading an opaque sandboxed iframe, asks for browser consent before the first App-initiated tool call, scopes those calls to the owning MCP server, and records bounded message/context intents for later Pi integration. Sessions use heartbeat-based expiry, persistent replayable SSE, strict CSP/permissions, a process-private backend secret, and no automatic opening of the App UI. Explicit App `openLink` requests are validated, recorded, and delegated to the browser with `noopener,noreferrer`. Local backend origins, secrets, and routes are not included in model-visible tool details.

## App publication (U4b)

Configure `/mcp` > Gateway explicitly before using Apps. The first active App verifies the selected exposure, obtains one process-local capability, and publishes a bounded dashboard; concurrent Apps remain isolated below its proxy. Gateway protocol v3 supports controlled same-protocol reconfiguration through the private Unix socket and fails closed against older resident daemons. Tailscale mode requires injected identity; custom mode relies on the capability and the user's network/proxy policy. The capability is removed when the last App completes or expires, and the compact Pi status link is cleared. Pi startup remains resource-idle, no browser is opened, and capability URLs and backend credentials never enter model-visible results.

<!-- AI generated -->
