# Pi Toolbox

A collection of packages, themes, and extensions for [Pi](https://github.com/earendil-works/pi).

## Installation

Install the whole toolbox globally from GitHub:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

Restart Pi after installation. Future updates can be pulled with:

```bash
pi update --extensions
```

To pin the installation to a tag or commit, append a ref such as `@v0.1.0`.

## Packages

### [`pi-claude-marketplace`](./packages/claude-marketplace)

Install and run Claude Code marketplace plugins in Pi.

### [`pi-claude-context`](./packages/claude-context)

Inject descendant Claude Code `CLAUDE.md` context files into Pi sessions.

### [`pi-claude-rules`](./packages/claude-rules)

Inject relevant Claude Code `.claude/rules/` files into Pi sessions.

### [`pi-learning`](./packages/pi-learning)

A pull-only, challenge-first technical learning mode for Pi.

### [`pi-mcp`](./packages/mcp)

MCP client and capability gateway with Streamable HTTP/SSE/stdio, OAuth, a secure local App host, persistent Pi status, and an interactive publication panel for either managed Tailscale Serve or a user-owned HTTPS reverse proxy. It never opens an App UI automatically and does not claim universal `pi-mcp-adapter` parity. See the package [parity matrix, migration runbook, and conformance command](./packages/mcp/PARITY.md).

### [`pi-session-title`](./packages/session-title)

Keep Pi session names synchronized with Herdr tabs, tmux windows, and terminal titles.

### [`pi-subagents`](./packages/subagents)

Spawn and manage autonomous background subagents powered by in-process Pi sessions or Claude Code, with user/project agent discovery and per-agent routing.

### [`pi-zed-context`](./packages/zed-context)

Attach Zed editor selections to the next Pi prompt and show the explicit selected-line count in Pi's footer. The task-based bridge works with local and remote Zed workspaces.

## Themes

### Fallout: New Vegas

The theme is available at [`themes/fallout-new-vegas.json`](./themes/fallout-new-vegas.json).

It is installed automatically with the toolbox. Select `fallout-new-vegas` from Pi's theme settings.
