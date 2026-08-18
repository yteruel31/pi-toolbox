# @yteruel31/pi-claude-rules

Pi extension that loads Claude Code rule files from repository and user scopes, then injects the relevant rule list into agent sessions.

## What it does

The extension reads Markdown rules from:

```txt
.claude/rules/
*/.claude/rules/
~/.claude/rules/
```

On session startup and resource discovery, it scans those directories, including descendant project rule directories, for Markdown files. Before an agent starts, it adds a `Claude rules` section to the system prompt that tells the agent to read relevant rule files before changing code.

Rules can include frontmatter path globs. For descendant project rule directories, path globs are matched relative to the current Pi working directory by prefixing the descendant project path:

```md
---
paths:
  - "src/**/*.ts"
  - "packages/*/README.md"
---

# TypeScript package rules
```

The extension tracks file paths mentioned through `read`, `write`, `edit`, and shell commands, then highlights path-matched rules first. If no path match exists, it falls back to text relevance based on the prompt and rule metadata.

## Install from npm

```bash
pi install npm:@yteruel31/pi-claude-rules
```

## Install from this repository

The root meta-package exposes this extension, so installing the repository loads it together with the other packaged Pi extensions:

```bash
pi install git:github.com/yteruel31/pi-toolbox@main
```

For local development from the repository root:

```bash
pi install ./packages/claude-rules
```

Then restart Pi or run `/reload`.

## Development

```bash
npm install
npm run check --workspace @yteruel31/pi-claude-rules
```
