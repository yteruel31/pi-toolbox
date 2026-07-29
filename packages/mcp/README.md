# pi-mcp

In-progress configuration foundation for a future private Tailnet MCP Apps gateway in Pi. This package does **not** yet run a gateway, connect MCP clients, host apps, authenticate users, or register Pi tools and commands.

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
