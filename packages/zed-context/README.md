# @yteruel31/pi-zed-context

Automatically attach code selected in Zed to the next Pi prompt while keeping Pi in its terminal TUI.

The integration works with local and remote Zed workspaces on macOS and Linux hosts. A small language
server runs on the same host as Pi, receives Zed's synchronized buffer and selection range, and writes
only the selected text to Pi's private state directory. No selection shortcut or client-side SQLite
access is required. Native Windows hosts are not currently supported.

## What it does

1. Select code in Zed.
2. Within about half a second, Pi's footer shows an explicit count:

   ```text
   ⧉ ⇡ 12 lignes sélectionnées · invoice.ts
   ```

3. Send your next Pi prompt. The selected text and file path are added to that turn's model context,
   then the footer changes from `⇡` (pending) to `✓` (attached).
4. Moving the cursor without a selection clears the pending context and footer.

Each changed selection is attached once. The bridge uses Zed's synchronized in-memory document, so
unsaved edits are included.

## Install

Install this package independently, or keep using the all-in-one `pi-toolbox`:

```bash
pi install npm:@yteruel31/pi-zed-context
```

### 1. Install the helper on the Pi host

After installing or updating, restart Pi and run:

```text
/zed-context setup
```

This installs `pi-zed-context` at `~/.local/bin/pi-zed-context` using the same Node executable as Pi.
For a remote Zed workspace, run the command in Pi on the remote host.

### 2. Install Pi Selection Bridge in Zed

Once **Pi Selection Bridge** is available in the Zed extension registry, install it from Zed's
Extensions page. Zed automatically propagates installed extensions to remote workspaces and runs the
bridge language server on the remote host.

To test the extension before registry publication:

1. Clone this repository on the machine running the Zed UI.
2. Run **zed: install dev extension**.
3. Select `packages/zed-context/zed-extension` from the local clone.
4. Open or reload the project where Pi is running.

A local clone is required for dev-extension installation even when the edited project is remote.
The language server itself still runs remotely.

## How it works

Zed refreshes code actions after local selection changes. Pi Selection Bridge declares an empty code
action provider, so it receives the current selection range after Zed's 250 ms debounce while always
returning an empty action list. It does not add entries to Zed's code-action menu.

The bridge also receives `didOpen` and incremental `didChange` notifications. It extracts the selected
text from the synchronized buffer using LSP UTF-16 positions and atomically updates the existing Pi
selection snapshot. Pi polls that private snapshot and attaches a non-empty selection to the next
prompt.

```text
Zed UI
  └─ selection change
       └─ Zed remote language client
            └─ pi-zed-context lsp (same host as Pi)
                 └─ /tmp/pi-zed-context-<uid>/*.json
                      └─ Pi TUI footer + next prompt context
```

There is no network listener, WebSocket, macOS daemon, or additional SSH connection.

### Concurrent Pi sessions

Selection state is intentionally repository-wide. If several Pi sessions are running in the same
repository, each session displays the current selection and may attach it once to its next prompt,
even when the sessions use different model providers. Use `/zed-context clear` in any matching Pi
session to clear the shared selection everywhere.

## Commands

- `/zed-context status` — show the pending or last attached selection.
- `/zed-context setup` — install or update the language-server helper.
- `/zed-context clear` — discard the selection for every matching Pi session and clear the footer.

## Explicit fallback

The original task-based capture command remains available if the automatic bridge cannot run for a
particular language:

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

Running this task is optional and is not part of the normal automatic workflow.

## Context limits and privacy

Pi receives at most 50 KB or 2,000 lines from one selection. The footer keeps showing the number of
lines originally selected, and the model context says when the text was truncated.

Selection snapshots are written atomically with user-only permissions under
`/tmp/pi-zed-context-<uid>`. The directory is mode `0700`, snapshots are mode `0600`, unsafe symlinked
or foreign-owned state is rejected, and captures older than 24 hours are ignored and removed.
Captures from a stopped language-server process are ignored. Override the location for testing with
`PI_ZED_CONTEXT_STATE_DIR`.

The language server receives open buffers through standard LSP synchronization but persists only the
current selected text, its file path, line count, and minimal lifecycle metadata.

## Troubleshooting

- Run `/zed-context setup` again after updating `pi-toolbox`.
- Run `/zed-context status` to verify whether Pi has received a selection.
- Use **zed: open log** and check for `pi-selection-bridge` startup errors.
- Confirm `~/.local/bin/pi-zed-context` exists on the same host as the language server.
- Ensure the file's language is listed in `zed-extension/extension.toml`. Zed does not currently
  support an all-languages wildcard for extension language servers; use the explicit fallback for an
  unlisted language and report it for inclusion.

The automatic trigger relies on Zed's eager code-action refresh behavior. If that behavior changes in
a future Zed release, the explicit task remains a deterministic fallback.

> AI generated.
