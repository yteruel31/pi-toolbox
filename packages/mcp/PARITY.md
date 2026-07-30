# pi-mcp parity and migration

This document compares this Phase-2 package with the current local `pi-mcp-adapter` 2.15 fork. It is a migration aid, not a claim of universal drop-in compatibility.

## Capability matrix

| Area | pi-mcp Phase 2 | Compared with pi-mcp-adapter 2.15 |
|---|---|---|
| Configuration sources | Merges `~/.config/mcp/mcp.json`, then `~/.pi/agent/mcp.json`, by server name | **Supported, design difference:** deliberately limited, validated two-layer contract |
| Transports | Streamable HTTP, explicit/automatic-fallback legacy SSE, and directly spawned stdio | **Supported** for the approved servers |
| OAuth | Authorization code, DCR, PKCE, remote/manual callback, refresh, private-file persistence | **Supported, design difference:** explicit flow and gateway setup; no browser auto-open |
| Tools / direct tools | Lazy multiplexed `mcp` tool plus global/per-server bounded direct-tool selection | **Supported, design difference:** aliases and opt-in exposure are intentionally conservative |
| Resources / prompts | Paginated list/read and list/get; resource templates discovered | **Supported** through qualified `mcp` actions |
| Sampling / elicitation | Consent-gated text sampling and bounded form elicitation | **Supported subset:** URL elicitation is intentionally not advertised; advanced/non-text modes are deferred |
| MCP Apps / remote access | Official AppBridge, isolated loopback host, private identity-gated Tailscale Serve gateway | **Supported for approved Tailnet use, design difference:** no public host and no automatic UI opening |
| Metadata / cache / reconnect | Bounded pagination, list-change refresh, private cache, reconnect, value-free diagnostics | **Supported** |
| Lifecycle / timeouts | Lazy startup, cancellation, bounded operations, stdio termination, coordinated shutdown | **Supported, design difference:** fixed safety bounds rather than adapter-wide tuning parity |
| UI panel / commands | Persistent status link; `/mcp-gateway setup`, `doctor`, and `remove` | **Partial:** no adapter-equivalent general MCP management panel |
| Secret storage | Mode `0700` directories and atomic mode `0600` files | **Intentional difference:** no OS keyring integration |
| Output guard | Bounded/redacted MCP and App output | **Supported in purpose, not byte-for-byte adapter behavior** |
| Trace | Bounded diagnostics and lifecycle counters | **Unsupported/deferred:** no adapter-compatible protocol trace facility |
| Host config discovery | The two documented MCP JSON files only | **Unsupported/deferred:** no broad host/editor config discovery |
| `rmcp-mux` socket | Not supported | **Unsupported/deferred** |
| Bearer/env/command interpolation | Literal validated headers/env; stdio command and args execute directly without a shell | **Unsupported/deferred:** no bearer helper or config interpolation/command substitution |
| Include/exclude filters | `directTools` boolean or bounded include list | **Partial:** no general include/exclude filter language |
| Prompt slash commands | Prompts available through qualified `mcp` operations | **Unsupported/deferred:** no generated slash commands |
| Tasks | No MCP Tasks support | **Unsupported/deferred** |

The missing management panel, keyring, trace compatibility, broad host discovery, `rmcp-mux`, interpolation, general filters, prompt slash commands, and Tasks mean **pi-mcp is not a universal drop-in replacement** for pi-mcp-adapter. They do **not** block the approved Mobbin/Tailnet setup, which uses the documented JSON route, HTTP OAuth, normal/direct tools, resources/prompts, and private MCP Apps publication. Re-evaluate this statement if that setup begins relying on any deferred feature.

## Executable conformance

From `packages/mcp`, run:

```bash
npm run check:conformance
```

The command first asserts that required named Phase-2 scenarios still exist, then executes the package's real SDK transport/protocol, OAuth, Apps, gateway, cache, lifecycle, and packaging suites. It uses loopback servers and temporary files only; it does not contact external services or mutate Tailscale or user configuration. `npm run check` includes this surface.

## Migration runbook (Mobbin/Tailnet)

1. **Install the local package without removing the adapter.** From this directory run `npm install`, validate with `npm run check`, and install/link it using the normal local Pi package workflow. Keep `pi-mcp-adapter` installed and its configuration intact until acceptance is complete.
2. **Configure only the intended route.** Add the Mobbin server to one of the documented MCP JSON files and configure the desired private gateway hostname, HTTPS port, and base path. Do not copy unsupported adapter settings and do not expose the gateway publicly.
3. **Inspect before mutation.** Run `/mcp-gateway doctor`. After reviewing its output, run `/mcp-gateway setup` to add the exact Tailscale Serve route non-destructively.
4. **Compare both clients.** Compare value-free diagnostics, connection state, and tool/resource/prompt inventory. Exercise representative normal and direct tool calls and verify cancellation/reconnect behavior.
5. **Accept OAuth and Apps.** Complete Mobbin OAuth (including callback and token reuse), call an App-bearing tool, open the private status link, and verify the App UI and same-server consented call through the Tailnet.
6. **Rollback on any discrepancy.** Stop using pi-mcp, remove only its exact route with `/mcp-gateway remove`, restore the previous Pi extension selection, and continue with the untouched adapter/configuration. Stored pi-mcp OAuth/cache files may be removed separately after provider-side revocation where appropriate.
7. **Remove the adapter only after acceptance.** Once diagnostics, inventory, OAuth, App UI, reconnect, and shutdown checks pass for the real workload, remove `pi-mcp-adapter`. Retain a copy of its configuration until the migration has remained stable.
