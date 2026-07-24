# Changelog

## [Unreleased]

### Added
- Initial package scaffold for `pi-claude-marketplace`.
- `/claude-marketplace-*` command namespace.
- `/claude-marketplace-plugin-*` namespace for plugin-level commands.
- Runtime prerequisite doctor for `pi-ask-user`, `pi-subagents`, and optional `pi-mcp-adapter`.
- Local marketplace registry commands: add, list, refresh, and remove.
- Plugin inspection commands: list, info, components, hooks, and MCP status.
- Plugin install/uninstall commands with multi-select dialogs when called without plugin arguments.
- Claude command bridge via `/claude-marketplace-plugin-run` plus generated wrapper commands after `/reload`.
- Claude skill bridge that generates collision-safe Pi skills for installed plugins and exposes them through `resources_discover`.
- Claude agent bridge that generates collision-safe Pi subagents for installed plugin agents and adds list/run helper commands.
- Hook bridge MVP for installed plugin `PreToolUse` command hooks, including `permission-guard@claude-tools` support; supported hooks are enabled automatically on plugin install and disabled automatically on uninstall.
- MCP bridge commands to diagnose, sync, and unsync installed plugin MCP servers through `pi-mcp-adapter` using generated Pi MCP config.
- Marketplace-level `.env` files for plugin MCP secrets, including install-time placeholder creation and manual env inspection/init commands.
- GitHub source-object plugin installs for external marketplace entries, including clone/ref/sha handling and post-download component scanning.
- Startup and `/reload` summary notifications plus a temporary below-prompt count for configured Claude marketplaces, installed plugins, enabled hooks, and synced MCP servers.
- Source-aware autocomplete display for generated Claude marketplace commands and skills, with shorter labels plus marketplace/plugin, argument hint, and description metadata.

### Fixed
- Quote generated skill frontmatter values so Claude plugin descriptions containing `:` parse as valid YAML.
- Preserve Claude skill frontmatter block-scalar descriptions without leaving invalid YAML continuation lines in generated Pi skills.
- Rewrite generated skills to replace Claude placeholders such as `${CLAUDE_PLUGIN_ROOT}` and copy plugin support directories like `scripts/` so relative references keep working in Pi.
- Rewrite Claude `Skill("plugin:skill", "args")` references in generated skills to Pi `/skill:claude-plugin-skill args` commands.
- Plugin uninstall now removes managed MCP sync entries before deleting plugin cache copies.
- MCP sync now resolves marketplace `.env` values into generated Pi MCP config and blocks when required server environment variables are missing instead of writing config that will close on connect.
- Root package dry packs now use an explicit allowlist to avoid including nested workspace `node_modules` binaries.
- Marketplace refresh updates already-installed plugin caches and regenerated skills/agents by default.
