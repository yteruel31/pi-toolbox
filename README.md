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

Phase-2 private Tailnet MCP client and Apps gateway for the approved Mobbin/Tailnet scope, with Streamable HTTP/SSE/stdio, OAuth, non-destructive explicit Tailscale Serve setup, a secure local App host, identity-gated capability dashboard, and persistent Pi status link. It never exposes publicly or opens an App UI automatically, and does not claim universal `pi-mcp-adapter` parity. See the package [parity matrix, migration runbook, and conformance command](./packages/mcp/PARITY.md).

### [`pi-session-title`](./packages/session-title)

Keep Pi session names synchronized with Herdr tabs, tmux windows, and terminal titles.

## Themes

### Fallout: New Vegas

The theme is available at [`themes/fallout-new-vegas.json`](./themes/fallout-new-vegas.json).

It is installed automatically with the toolbox. Select `fallout-new-vegas` from Pi's theme settings.
