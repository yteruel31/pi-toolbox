# @yteruel31/pi-ask

A Pi package that adds `ask_user_question`: a structured, keyboard-first clarification flow with single-select, multi-select, preview panes, free-form answers, notes, review, elaboration, notifications, replay, and interrupted-flow recovery.

```bash
pi install npm:@yteruel31/pi-ask
```

The package also installs the `ask-user` decision-gate skill.

## Updating and verifying the loaded tool

The source rename to `ask_user_question` is already shipped. Updating an installation only changes files on disk; it does not prove that the current Pi session has reloaded them or that its active tool inventory comes from the corrected package. After updating, run `/reload` when the package is in a reloadable location, or start a fresh Pi session. Then inspect the active tool inventory and confirm that Ask exposes exactly `ask_user_question`, with no `ask_user` alias.

These verification steps are read-only apart from reloading the session: they do not require edits to global Pi settings or the primary checkout. If the old name remains visible, identify the loaded package path/version and remove or update the stale package through your normal installation workflow before opening another fresh session.

## Commands

- `/ask-settings` — change persisted behaviour and notification toggles
- `/answer` — extract questions from the latest completed assistant response
- `/answer:again` — replay the latest extracted form on the active branch
- `/ask:replay` — replay the latest real `ask_user_question` form on the active branch

The rich surface is TUI-only. Print, JSON, and RPC tool calls return a cancelled result containing the pending questions rather than attempting terminal automation.

Long questions stay inside a terminal-height viewport. Use `Shift+↑` and `Shift+↓` to scroll its content while unmodified arrow keys continue to navigate options.

When Pi runs inside Herdr with its Pi integration installed, an open clarification flow marks the pane as blocked until the flow closes. The package emits Herdr's standard `herdr:blocked` events and remains a no-op when that integration is absent.

Inside an Orca-owned terminal, Orca's native Pi hook owns blocked/working/done status and notification policy. Ask emits no OSC 9999 status lifecycle and suppresses its configured bell, OSC 9/777, and command notifications there to avoid duplicates. Outside Orca, configured notifications remain available. See [Orca native status](docs/orca-status.md) for verified behavior and reply-control limitations.

Configuration is stored at `~/.pi/agent/extensions/yteruel31-pi-ask.json`. See [configuration](./docs/configuration.md), the [tool contract](./docs/contract.md), and [remote events](./docs/remote-events.md).

## Clean-room acknowledgment

The behavior and terminal UI of this independent clean-room implementation were inspired by [`@eko24ive/pi-ask`](https://github.com/eko24ive/pi-ask). The implementation and tests in this package were written independently from public documentation and screenshots; this acknowledgment does not claim that upstream source code was copied.

## Development

```bash
npm run check -w @yteruel31/pi-ask
npm run pack:dry -w @yteruel31/pi-ask
```

MIT © Yoann Teruel
