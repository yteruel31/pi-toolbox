# pi-zed-context

Attach code selected in Zed to the next Pi prompt while keeping Pi in its terminal TUI.

This package is designed for both local and remote Zed workspaces. It does not depend on
Zed's client-side SQLite database: a Zed task sends the current selection to a small helper
on the same host as Pi.

## What it does

1. Select code in Zed.
2. Press `Ctrl+Alt+K` (`Ctrl+Option+K` on macOS).
3. Pi's footer shows an explicit count, for example:

   ```text
   ⧉ ⇡ 12 lignes sélectionnées · invoice.ts
   ```

4. Send your next Pi prompt. The selected text and file path are added to that turn's model
   context, then the footer changes from `⇡` (pending) to `✓` (attached).

A selection is attached once. Press the shortcut again to attach it to another prompt.

## Install

The extension is included in `pi-toolbox`. After updating the toolbox, restart Pi and run:

```text
/zed-context setup
```

This installs `pi-zed-context` in `~/.local/bin`. The task below uses its absolute
`$HOME`-relative path, so Zed does not need a customized `PATH`.

## Configure Zed

Open the global task file with **zed: open tasks**, then add this task to the JSON array:

```json
{
  "label": "Pi: Attach Selection",
  "command": "$HOME/.local/bin/pi-zed-context",
  "args": [
    "capture",
    "--workspace",
    "$ZED_WORKTREE_ROOT",
    "--file",
    "$ZED_FILE",
    "--row",
    "$ZED_ROW"
  ],
  "env": {
    "PI_ZED_SELECTED_TEXT": "$ZED_SELECTED_TEXT"
  },
  "reveal": "never",
  "hide": "always",
  "show_summary": false,
  "show_command": false,
  "save": "none"
}
```

Open **zed: open keymap** and add this binding to the JSON array:

```json
{
  "context": "Editor",
  "bindings": {
    "ctrl-alt-k": [
      "task::Spawn",
      { "task_name": "Pi: Attach Selection" }
    ]
  }
}
```

Zed only resolves this task when text is selected because the helper consumes
`ZED_SELECTED_TEXT`.

## Commands

- `/zed-context status` — show the pending or last attached selection.
- `/zed-context setup` — install/update the task helper in `~/.local/bin`.
- `/zed-context clear` — discard the pending selection and clear the footer.

## Context limits

Pi receives at most 50 KB or 2,000 lines from one selection. The footer keeps showing the
number of lines originally selected, and the model context says when the text was truncated.

Selection snapshots are written with user-only permissions under
`/tmp/pi-zed-context-<uid>` and stale files are removed after 24 hours. Override the location
for testing with `PI_ZED_CONTEXT_STATE_DIR`.
