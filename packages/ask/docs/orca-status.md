# Orca native question status

Ask does not emit OSC 9999. In an Orca-owned PTY (`ORCA_PANE_KEY` is set),
configured bell, OSC 9/777, and command notifications are also suppressed so
Orca remains the only status and notification owner. Outside Orca, those
ordinary channels remain configurable.

## Verified behavior in Orca 1.4.197

Read-only inspection of the installed Orca application shows that its Pi-family
hook:

- normalizes tool names by removing punctuation and lowercasing, then recognizes
  `askuserquestion` and `requestuserinput`; therefore Pi
  `ask_user_question` is recognized, while historical `ask_user` is not;
- maps a recognized Pi question `tool_call` or `tool_execution_start` event to
  `blocked`;
- maps `agent_end` to `done`, while ordinary tool and message lifecycle events
  map to `working`;
- serializes the tool input as the interactive prompt. Its answer-intent helper
  expects an object with a `questions` array. For one question it inspects
  `multiSelect` and `options`: Enter can count as submit, and a digit counts only
  when it addresses a declared option. Multiple questions, `multiSelect: true`,
  malformed/truncated JSON, and the synthetic custom-answer row fail closed for
  digit-based completion.

Ask's public input also has `questions` and `options`, but represents selection
mode as `type: "single" | "multi" | "preview"`, uses `prompt`, and identifies
options with stable `value` plus `label`. It does not expose Claude's
`multiSelect` field. Consequently Orca can recognize the tool and own its status,
but its single-keystroke answer-intent heuristic is not a semantic adapter for
Ask's richer multi-question, notes, preview, custom-answer, or review flow. Pi's
Ask TUI remains responsible for collecting and returning the actual answer.
There is no native reply-control API in the inspected files that can submit an
Ask result or translate Orca UI answers into Ask's result contract, so this
change does not redesign the UI around such a path.

## Manual live verification and troubleshooting

Source inspection and package tests cannot establish the status shown by a currently running Orca terminal. Installing an update is likewise not proof that the active Pi session loaded it. Reload the corrected package when supported, or use a fresh Pi session, before this read-only checklist:

1. Inspect the active tool inventory and confirm that Ask exposes exactly `ask_user_question`, with no `ask_user` alias.
2. Ask one real inline `ask_user_question`; do not use `/answer`, replay, or a prose question for this check.
3. Confirm that Orca sends one notification and shows the pending/blocked state throughout the interaction.
4. Answer or cancel the form, then confirm that Orca settles after that result or after any resulting later model turn.

No global Pi settings or primary-checkout edits are required for this verification. Record the loaded package path/version and lifecycle observations if the result differs. A user has reported receiving one notification while Orca still displayed working during the pending interaction; that observation does not establish a causal link to the historical tool name. Until the checklist is reproduced in a live Orca session, do not infer from source inspection that status settlement is fixed.

## Operational limitations

- A prose question is not a structured tool event. Orca receives normal Pi
  completion and reports `done`; Ask does not attempt semantic question
  detection.
- `/answer`, `/answer:again`, and `/ask:replay` open a form from a command, so
  opening the form itself has no Pi question-tool event for Orca. If submission
  injects a new user message, subsequent native lifecycle events describe that
  model turn.
- Sessions that previously received retained Ask OSC 9999 rows may continue to
  show that stale retained state. Restart the Orca/Pi session to clear it; the
  corrected extension does not emit a competing cleanup status.
- The user-reported permanent-blocked problem was not reproduced in a live Orca
  smoke test here, so this document does not claim a proven root cause. The
  related user-reported issue is open at
  <https://github.com/stablyai/orca/issues/10454>.

Automated tests capture every attempted terminal write and verify that questions,
answers, cancellation, replay, later turns, settlement, and shutdown emit no Ask
status output in Orca. They also verify disabled notifications and ordinary
notification delivery outside Orca. No live Orca smoke test is performed by the
package test suite.
