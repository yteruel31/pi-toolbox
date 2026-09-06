# @yteruel31/pi-ask

A Pi package that adds `ask_user`: a structured, keyboard-first clarification flow with single-select, multi-select, preview panes, free-form answers, notes, review, elaboration, notifications, replay, and interrupted-flow recovery.

```bash
pi install npm:@yteruel31/pi-ask
```

The package also installs the `ask-user` decision-gate skill.

## Commands

- `/ask-settings` — change persisted behaviour and notification toggles
- `/answer` — extract questions from the latest completed assistant response
- `/answer:again` — replay the latest extracted form on the active branch
- `/ask:replay` — replay the latest real `ask_user` form on the active branch

The rich surface is TUI-only. Print, JSON, and RPC tool calls return a cancelled result containing the pending questions rather than attempting terminal automation.

Long questions stay inside a terminal-height viewport. Use `Shift+↑` and `Shift+↓` to scroll its content while unmodified arrow keys continue to navigate options.

When Pi runs inside Herdr with its Pi integration installed, an open clarification flow marks the pane as blocked until the flow closes. The package emits Herdr's standard `herdr:blocked` events and remains a no-op when that integration is absent.

Inside an Orca-owned terminal, the package automatically emits Orca's OSC 9999 waiting status while the clarification UI is open, then restores working status on submit, cancel, or abort. Orca ownership is detected from its `ORCA_PANE_KEY` PTY contract; no hook or setting changes are required. The waiting payload includes a sanitized, Unicode-safe preview of the first question's prompt and the question count when there are several; this text may appear in native desktop notifications. The cleanup payload clears that preview. To avoid duplicate alerts, configured bell, OSC 9/777, and command channels are bypassed in Orca. New waiting signals respect the notification toggle. After a question closes, Ask emits `done` only when Pi fully settles (or an idle command is cancelled), not while the model continues. Once engaged, the OSC lifecycle stays synchronized on subsequent runs so a retained status cannot mask the native hook. See [Orca status lifecycle](docs/orca-status.md) for protocol evidence, shutdown/error behaviour, and a live smoke checklist.

Configuration is stored at `~/.pi/agent/extensions/yteruel31-pi-ask.json`. See [configuration](./docs/configuration.md), the [tool contract](./docs/contract.md), and [remote events](./docs/remote-events.md).

## Clean-room acknowledgment

The behavior and terminal UI of this independent clean-room implementation were inspired by [`@eko24ive/pi-ask`](https://github.com/eko24ive/pi-ask). The implementation and tests in this package were written independently from public documentation and screenshots; this acknowledgment does not claim that upstream source code was copied.

## Development

```bash
npm run check -w @yteruel31/pi-ask
npm run pack:dry -w @yteruel31/pi-ask
```

MIT © Yoann Teruel
