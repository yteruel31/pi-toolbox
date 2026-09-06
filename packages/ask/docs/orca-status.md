# Orca status lifecycle

Ask uses OSC 9999 only in an Orca PTY (`ORCA_PANE_KEY`). If
`ORCA_PI_STATUS_OWNED` identifies another PID, this process is an inherited child
and must not change the parent pane's status. No HTTP credentials or endpoint
configuration are read or changed by Ask.

## Why cleanup alone is insufficient

Verified against installed Orca **1.4.197** (its CLI-served `orca-cli` guide,
`out/main/index.js` in the application archive, and the managed
`orca-agent-status.ts` Pi extension):

- OSC 9999 accepts `working`, `blocked`, `waiting`, and **`done`**. `idle` is not
  a terminal OSC state; it belongs to other internal representations.
- The managed native hook posts Pi's completion to `/hook/pi`; Orca maps its
  `agent_end` hook payload to `done`. Modern Pi's `agent_settled` triggers that
  post. The native extension also has a legacy idle-recheck fallback.
- OSC input also creates a retained runtime agent row. In particular, the
  mobile/session-tab projection prefers that fresh retained row over the native
  hook row for up to 30 minutes. A later native HTTP `done` is therefore not a
  reliable way to close an OSC `working` row.
- The installed native hook does not provide a question-preview override API.
  Dropping Ask's OSC signal would lose its question notification/preview.

Ask must balance its own OSC lifecycle rather than replace or reconfigure the
native integration. The native hook remains responsible for richer session and
assistant metadata. No terminal-text parsing or timeout-based completion is used.

## Boundaries

- Opening a question emits `waiting`, `toolName: ask_user`, and the sanitized
  first-question preview (at most 160 UTF-16 units, including question count).
  The preview may appear in desktop notifications; do not put secrets in prompts.
- Closing it emits `working` without tool fields, including cancellation, abort,
  and UI errors. This is **not** agent completion: the model may continue.
- `agent_settled`, guarded by `ctx.isIdle()`, emits `done`. `agent_end` is
  deliberately ignored: retries, compaction, and queued follow-ups may remain.
  This uses the Pi lifecycle API tested with the repository's Pi 0.84.2 dependency.
- Cancelled/failed command replay or recovery settles immediately only if Pi is
  idle. Successful submission waits for the injected prompt to settle, even if
  that prompt has not started yet. `/answer` uses the same result delivery path.
- Overlapping questions keep the remaining question's preview. Session shutdown
  closes the retained status and invalidates late UI cleanup callbacks.
- Once Ask has emitted OSC in a session, subsequent agent starts and settlements
  are also mirrored. Otherwise its retained `done` could mask a later native
  `working`, even on a run with no questions.

Disabling notifications prevents new Ask waiting signals. If an OSC lifecycle
was already engaged, its cleanup and subsequent start/settle synchronization
continue until session teardown so the old row cannot strand the pane. Outside
Orca, configured bell/OSC 9/OSC 777/command channels are unchanged. Inside Orca,
those channels are bypassed to avoid duplicate alerts. Delivery is best effort;
closed terminals and hard process kills cannot guarantee a final signal.

## Manual smoke check

Load this worktree's extension in an isolated Orca Pi terminal (do not load a
second installed copy of Ask). Check both the desktop status and session-tab/
mobile status:

1. Ask a question: one question notification, correct prompt preview.
2. Answer and have the model continue using tools: still working, no premature
   completion. When Pi fully settles: done.
3. Repeat with Esc/abort and a model error; run another prompt without Ask.
4. Cancel `/ask:replay` while idle; submit it and verify completion is deferred
   until the resulting model run settles.
5. Disable notifications in a fresh session; repeat outside Orca.

Automated tests exercise the real Ask extension/UI lifecycle with a fake Pi host
and capture OSC output without sending it to the developer's live pane. They do
not replace this end-to-end UI check against the running Orca application.
