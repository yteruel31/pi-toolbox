# @yteruel31/pi-session-title

Keep Pi session names synchronized with Herdr tabs, tmux windows, and terminal titles.

## What it does

- Generates a short title from the first user prompt and stores it as the Pi session name.
- Restores an existing Pi session name when a session is resumed.
- Renames the current Herdr tab when Pi runs inside Herdr.
- Renames the current tmux window when Pi runs inside tmux.
- Updates the host terminal title and displays the current session name in Pi's status bar in interactive sessions.
- Provides `/rename <title>` for manual names and `/rename` for a new AI-generated name based on the conversation.
- Falls back to deterministic prompt keywords when the active model or credentials are unavailable.

Generated titles use the currently selected Pi model with a four-second timeout. Generation runs in the background so the first agent turn does not wait for the title. The extension sends at most 1,200 characters of the prompt or conversation excerpt to that same configured model provider for title generation.

## Install

From npm:

```bash
pi install npm:@yteruel31/pi-session-title
```

From this repository:

```bash
pi install ./packages/session-title
```

The root toolbox package also exposes this extension:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

Restart Pi or run `/reload` after installation.

## Herdr integration

Herdr tab renaming is enabled automatically when Herdr provides both environment variables:

```text
HERDR_ENV=1
HERDR_TAB_ID=<current-tab-id>
```

The `herdr` executable must be available on `PATH`. If it is unavailable or a rename fails, the extension continues without blocking Pi and still updates the terminal title.

Starting a new Pi session resets a custom Herdr tab label to its numeric tab number before a new task title is generated.

## Commands

```text
/rename Fix OAuth callback
/rename
```

- `/rename <title>` immediately applies the supplied title to Pi and supported terminal hosts.
- `/rename` generates a fresh short title from the current conversation.
- Pi's built-in `/name` command remains supported; changes made through it are synchronized to Herdr, tmux, and the terminal title.

## Development

Requires Node.js 22.19 or newer and targets Pi 0.84.2.

```bash
npm install --ignore-scripts
npm run check --workspace @yteruel31/pi-session-title
npm run pack:dry --workspace @yteruel31/pi-session-title
```
