# pi-mcp

In-progress private Tailnet MCP Apps gateway for Pi. The package can manage the local gateway and its Tailscale Serve route, but it does **not** yet connect MCP clients, host apps, or authenticate users.

## Configuration contract

Configuration is read in order from `~/.config/mcp/mcp.json`, then `~/.pi/agent/mcp.json`. Server entries are merged by name; the Pi layer replaces matching entries. Its valid UI fields augment the lower layer. Missing and invalid files fail safely with structured, value-free diagnostics.

```json
{
  "mcpServers": {
    "example": { "url": "https://example.invalid/mcp" }
  },
  "settings": {
    "ui": {
      "hostname": "auto",
      "httpsPort": 8443,
      "basePath": "/mcp-ui",
      "gatewayPort": 19877,
      "requireTailscaleIdentity": true,
      "idleTimeoutMs": 300000
    }
  }
}
```

Server definitions remain opaque plain objects for future transports. Configuration values are never passed to shell commands.

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

## Private gateway (U2)

`/mcp-gateway setup` persistently adds only the configured Tailscale Serve HTTPS path; existing Serve routes are retained. `/mcp-gateway doctor` reports local gateway/config, hostname, and route state. `/mcp-gateway remove [--yes]` removes only an exactly matching route and asks for confirmation unless `--yes` is supplied. The gateway starts on demand, binds its public listener to `127.0.0.1`, and uses private capability URLs; loading the extension starts no service.
