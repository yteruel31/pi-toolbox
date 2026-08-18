# @yteruel31/pi-claude-marketplace

Pi extension for installing and running Claude Code marketplace plugins.

## Command namespace

All user-facing commands are prefixed with `/claude-marketplace-*` so the scope is explicit.

Implemented marketplace commands:

```txt
/claude-marketplace-doctor
/claude-marketplace-list
/claude-marketplace-add <source>
/claude-marketplace-refresh [marketplace]
/claude-marketplace-remove <marketplace>
```

Implemented plugin commands:

```txt
/claude-marketplace-plugin-list [--available|--installed|--all]
/claude-marketplace-plugin-info <plugin[@marketplace]>
/claude-marketplace-plugin-install [plugin[@marketplace] ...]
/claude-marketplace-plugin-uninstall [plugin[@marketplace] ...]
/claude-marketplace-plugin-run <plugin[@marketplace]> <command> [args...]
/claude-marketplace-plugin-components <plugin[@marketplace]>
/claude-marketplace-plugin-agents <plugin[@marketplace]>
/claude-marketplace-plugin-agent-run <plugin[@marketplace]> <agent> <task>
/claude-marketplace-plugin-hooks <plugin[@marketplace]>
/claude-marketplace-plugin-hooks-enable <plugin[@marketplace]>
/claude-marketplace-plugin-hooks-disable <plugin[@marketplace]>
/claude-marketplace-plugin-env <plugin[@marketplace]>
/claude-marketplace-plugin-env-init <plugin[@marketplace]>
/claude-marketplace-plugin-mcp <plugin[@marketplace]>
/claude-marketplace-plugin-mcp-doctor <plugin[@marketplace]>
/claude-marketplace-plugin-mcp-sync <plugin[@marketplace] ...>
/claude-marketplace-plugin-mcp-unsync [plugin[@marketplace] ...]
```

Local marketplace add syntax:

```txt
/claude-marketplace-add /path/to/claude-plugins-marketplace
```

Dialog commands:

```txt
/claude-marketplace-plugin-install
/claude-marketplace-plugin-uninstall
```

When called without plugin arguments, install opens a multi-select dialog containing available plugins that are not already installed. Uninstall opens the same style of dialog containing installed plugins only.

On Pi startup and after `/reload`, the extension shows a concise Claude Marketplace summary when marketplaces or plugins are configured. The compact count, such as `Claude Marketplace: 3 plugins, 1 hook, 1 MCP`, appears temporarily below the prompt input instead of staying in the persistent footer/status bar. The extension also warns when required packages are missing or MCP servers are synced while `pi-mcp-adapter` is unavailable.

Refreshing marketplaces also updates already-installed plugins from the refreshed marketplace indexes by default. This refreshes the local plugin cache, rescans components, and regenerates bridged skills and agents. Run `/reload` after refresh so Pi picks up the regenerated resources.

Marketplace entries can be local paths or GitHub source objects such as the external `compound-engineering` entry in `claude-tools`. GitHub plugins are downloaded with `git`, verified against their declared `sha` when present, copied into the normal local cache, then scanned/generated like local plugins. Installing GitHub sources shows an additional trust confirmation because the downloaded plugin may later expose commands, skills, agents, hooks, or MCP servers.

Installed plugin commands can be run with the canonical runner:

```txt
/claude-marketplace-plugin-run git-pr-workflows@claude-tools create-pr add command bridge
```

After `/reload`, installed plugin commands also get generated wrappers such as:

```txt
/claude-marketplace-git-pr-workflows-create-pr add command bridge
```

In slash-command autocomplete, generated plugin commands are displayed with a shorter skill-like label such as `claude-marketplace:git-pr-workflows:create-pr`, while still inserting the real generated wrapper command. Their descriptions include source and argument metadata in the form `(claude-tools:git-pr-workflows): [argument-hint] — description`.

Installed plugin skills are generated with collision-safe names like `claude-git-pr-workflows-commit-creation` and exposed through Pi's normal `/skill:<name>` command surface after `/reload`. In autocomplete, generated Claude marketplace skills get the same source-aware description format, and the UI may display a shorter label such as `skill:commit-creation` while preserving the real `/skill:claude-git-pr-workflows-commit-creation` invocation. The marketplace/plugin source stays in the description, for example `(claude-tools:git-pr-workflows): [argument-hint] — description`. The generator rewrites Claude placeholders such as `${CLAUDE_PLUGIN_ROOT}` to the installed cache path and copies support directories such as `scripts/` so relative references continue to work.

Installed plugin agents are generated as Pi subagent files under:

```txt
~/.pi/agent/agents/claude-marketplace/<marketplace>/<plugin>/
```

List generated names with:

```txt
/claude-marketplace-plugin-agents git-pr-workflows@claude-tools
```

Run one with Pi's normal subagent command:

```txt
/run claude-claude-tools-git-pr-workflows-code-reviewer "review this diff"
```

or through the bridge helper:

```txt
/claude-marketplace-plugin-agent-run git-pr-workflows@claude-tools code-reviewer review this diff
```

Claude MCP direct-tool names in agent metadata are mapped to the Pi `mcp` proxy tool when present.

## Hooks bridge

Hooks are high-trust, but installed plugins now follow Claude marketplace semantics more closely: supported hooks are enabled automatically when a plugin is installed and disabled automatically when it is uninstalled. The current hook MVP supports installed plugin `PreToolUse` command hooks, with Claude-compatible stdin and JSON decision parsing.

This is enough for `permission-guard@claude-tools`:

```txt
/claude-marketplace-plugin-install permission-guard@claude-tools
/claude-marketplace-plugin-hooks permission-guard@claude-tools
```

You can still manually toggle hooks after install:

```txt
/claude-marketplace-plugin-hooks-enable permission-guard@claude-tools
/claude-marketplace-plugin-hooks-disable permission-guard@claude-tools
```

The bridge maps Pi tool names to Claude-style names before invoking the hook, for example `bash` -> `Bash`, `read` -> `Read`, and `web_search` -> `WebSearch`. Hook commands receive:

- `${CLAUDE_PLUGIN_ROOT}` pointing at the installed cache copy;
- `${CLAUDE_PLUGIN_DATA}` pointing at durable plugin data;
- variables from `~/.pi/agent/claude-marketplace/env/<marketplace>.env`;
- Claude `userConfig` values as `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables.

The bridge reads `userConfig` declarations from `.claude-plugin/plugin.json`. Since Pi doesn't have Claude Code's keychain-backed plugin configuration UI, sensitive and non-sensitive options are resolved from the marketplace env file using the same runtime env names Claude exposes to subprocesses. For example, `gemini_api_key` becomes `CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY`. Hook commands and MCP config strings can also use Claude-style `${user_config.key}` placeholders, which are replaced from the same values.

For `permission-guard`, set `PERMISSION_GUARD_LLM_ENABLED=false` in the marketplace env file for regex-only mode, or provide `CLAUDE_PLUGIN_OPTION_GEMINI_API_KEY` for LLM judging. By default the bridge redirects permission-guard logs/cache into `${CLAUDE_PLUGIN_DATA}/logs` and `${CLAUDE_PLUGIN_DATA}/cache` instead of `~/.claude`.

## Required Pi packages

This package expects the user to install and enable:

```bash
pi install npm:pi-ask-user
pi install npm:@yteruel31/pi-subagents
```

Why:

- `pi-ask-user` is required for trust decisions, hook/MCP consent, and Claude `ask`-style permission decisions.
- `@yteruel31/pi-subagents` is required to expose Claude agents and to support `SubagentStart` / `SubagentStop` lifecycle compatibility.

## Optional Pi packages

For MCP support:

```bash
pi install npm:pi-mcp-adapter
```

MCP servers bundled in Claude plugins are not enabled automatically. Use `/claude-marketplace-plugin-mcp-doctor <plugin>` to inspect local code, environment variables, runtime dependencies, and first-run install behavior.

When installing a plugin that needs MCP environment variables, the extension creates or updates a marketplace-level env file:

```txt
~/.pi/agent/claude-marketplace/env/<marketplace>.env
```

For already-installed plugins, run `/claude-marketplace-plugin-env-init <plugin>` to create missing placeholders for MCP environment variables and plugin `userConfig` options. Use `/claude-marketplace-plugin-env <plugin>` to inspect required variables without printing secret values.

Use `/claude-marketplace-plugin-mcp-sync <plugin>` to generate Pi MCP adapter config in `~/.pi/agent/mcp.json`; sync is lazy/proxy-only by default, does not start server code, resolves marketplace env values into the generated config, and blocks when required environment variables are missing. Use `/claude-marketplace-plugin-mcp-unsync <plugin>` to remove managed entries.

## Install

From npm:

```bash
pi install npm:@yteruel31/pi-claude-marketplace
```

From a local checkout:

```bash
pi install ./packages/claude-marketplace
```

## Install from git root meta-package

The parent monorepo can expose this package from its root `pi` manifest:

```bash
pi install git:github.com/yteruel31/pi-toolbox@main
```

## State layout

Planned global state directory:

```txt
~/.pi/agent/claude-marketplace/
  marketplaces.json
  installed.json
  hooks.json
  cache/
  generated/
  data/
  env/
    <marketplace>.env
  logs/
~/.pi/agent/agents/claude-marketplace/<marketplace>/<plugin>/  # generated Pi subagents
~/.pi/agent/mcp.json  # pi-mcp-adapter config updated by MCP sync
```
