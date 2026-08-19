# `@yteruel31/pi-ui-customization`

A responsive structured footer for Pi Toolbox sessions. It groups session, MCP, path, context, model, thinking, and subagent information into labelled columns while preserving statuses from other extensions.

## Install from npm

```bash
pi install npm:@yteruel31/pi-ui-customization
```

Restart Pi after installation. Use `/footer` to switch between the structured footer and Pi's built-in footer.

The MCP and subagent columns use versioned events published by `@yteruel31/pi-mcp` and `@yteruel31/pi-subagents`. When either package is absent, its column is omitted and any text status from an independently installed extension remains visible.

## Install from this repository

The extension is included automatically when installing the complete toolbox:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

## Development

```bash
npm install
npm run check --workspace @yteruel31/pi-ui-customization
npm run pack:dry --workspace @yteruel31/pi-ui-customization
```

<!-- AI generated -->
