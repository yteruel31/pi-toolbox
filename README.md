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

To pin the installation to a tag or commit, append a ref such as `@v1.12.0`.

Every package can also be installed and updated independently from npm:

```bash
pi install npm:@yteruel31/pi-subagents
```

All package names and install commands are listed below. The root toolbox remains the Git-installable all-in-one bundle; npm workspaces and Changesets provide independent package versions and releases.

## Packages

### [`@yteruel31/pi-ask`](./packages/ask)

```bash
pi install npm:@yteruel31/pi-ask
```

Open structured, keyboard-first `ask_user` decision flows with notes, previews, replay, recovery, notifications, and a bundled decision-gate skill.

### [`@yteruel31/pi-claude-marketplace`](./packages/claude-marketplace)

```bash
pi install npm:@yteruel31/pi-claude-marketplace
```

Install and run Claude Code marketplace plugins in Pi.

### [`@yteruel31/pi-claude-context`](./packages/claude-context)

```bash
pi install npm:@yteruel31/pi-claude-context
```

Inject descendant Claude Code `CLAUDE.md` context files into Pi sessions.

### [`@yteruel31/pi-claude-rules`](./packages/claude-rules)

```bash
pi install npm:@yteruel31/pi-claude-rules
```

Inject relevant Claude Code `.claude/rules/` files into Pi sessions.

### [`@yteruel31/pi-learning`](./packages/pi-learning)

```bash
pi install npm:@yteruel31/pi-learning
```

A pull-only, challenge-first technical learning mode for Pi.

### [`@yteruel31/pi-mcp`](./packages/mcp)

```bash
pi install npm:@yteruel31/pi-mcp
```

MCP client and capability gateway with Streamable HTTP/SSE/stdio, OAuth, a secure local App host, persistent Pi status, and an interactive publication panel for either managed Tailscale Serve or a user-owned HTTPS reverse proxy. It never opens an App UI automatically and does not claim universal `pi-mcp-adapter` parity. See the package [parity matrix, migration runbook, and conformance command](./packages/mcp/PARITY.md).

### [`@yteruel31/pi-session-title`](./packages/session-title)

```bash
pi install npm:@yteruel31/pi-session-title
```

Keep Pi session names synchronized with Herdr tabs, tmux windows, and terminal titles.

### [`@yteruel31/pi-subagents`](./packages/subagents)

```bash
pi install npm:@yteruel31/pi-subagents
```

Spawn and manage autonomous background subagents powered by in-process Pi sessions or Claude Code, with user/project agent discovery and per-agent routing.

### [`@yteruel31/pi-zed-context`](./packages/zed-context)

```bash
pi install npm:@yteruel31/pi-zed-context
```

Automatically attach Zed editor selections to the next Pi prompt and show the explicit selected-line count in Pi's footer. The language-server bridge includes unsaved edits and works with local and remote Zed workspaces without a shortcut.

### [`@yteruel31/pi-ui-customization`](./packages/ui-customization)

```bash
pi install npm:@yteruel31/pi-ui-customization
```

Replace Pi's built-in footer with a responsive structured view of session, MCP, path, context, model, thinking, subagent, and extension status information.

### [`@yteruel31/pi-unslop`](./packages/unslop)

```bash
pi install npm:@yteruel31/pi-unslop
```

Add best-effort anti-slop prose guidance and teach Pi a reusable global writing voice with `/unslop teach`.

## Themes

### Fallout: New Vegas

The theme is available at [`themes/fallout-new-vegas.json`](./themes/fallout-new-vegas.json).

It is installed automatically with the toolbox. Select `fallout-new-vegas` from Pi's theme settings.

## Publishing packages

Package changes use Changesets:

```bash
npm run changeset
npm run check:packages
```

No npm publication workflow is enabled yet. The package manifests, validation commands, and Changesets configuration are kept ready for a future publishing step, while merges to `main` continue to use only the toolbox's existing GitHub release workflow.

<!-- AI generated -->
