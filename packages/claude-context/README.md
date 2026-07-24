# pi-claude-context

Pi extension that loads Claude Code `CLAUDE.md` context files from the current directory and descendant project directories, then injects the relevant context file list into agent sessions.

## What it does

The extension reads Markdown context files from:

```txt
CLAUDE.md
*/CLAUDE.md
```

On session startup and resource discovery, it scans the current directory and descendant project directories. Before an agent starts, it adds a `Claude context files` section to the system prompt that tells the agent to read relevant context files before changing code.

The extension tracks file paths mentioned through `read`, `write`, `edit`, and shell commands, then highlights context files whose directory contains those paths. If no path match exists, it falls back to text relevance based on the prompt and context file metadata.

## Install from npm

If published to npm:

```bash
pi install npm:pi-claude-context
```

## Install from this repository

The root meta-package exposes this extension, so installing the repository loads it together with the other packaged Pi extensions:

```bash
pi install git:github.com/gigapay/pi-packages@main
```

For local development from the repository root:

```bash
pi install ./packages/claude-context
```

Then restart Pi or run `/reload`.

## Development

```bash
pnpm install
pnpm check
```
