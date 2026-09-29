# Host lifecycle integration

## What this package provides

The existing `pi-toolbox:subagents:status` aggregate channel and standalone Pi UI are unchanged. A second, host-neutral `pi.events` channel, `pi-toolbox:subagents:lifecycle`, exposes each run. This is an in-process extension bus, not a Pi RPC event. Installing this package alone does **not** add native subagent display to BB.

The public types and channel constants are exported from the package entry point. Each event has `v: 1`, `sessionId` (Pi session), `sourceId` (unique publisher lifetime), and an increasing `sequence` scoped to that source. Event variants are:

```ts
{ ...envelope, kind: "snapshot", runs: SubagentLifecycleRun[] }
{ ...envelope, kind: "upsert", run: SubagentLifecycleRun }
{ ...envelope, kind: "clear" }
```

A run contains `id`, `label`, optional `toolCallId`, `harness`, `status`, `createdAt`, and optional `settledAt`. Status is exactly `queued | running | completed | failed | cancelled`. Timestamps are milliseconds. Run IDs are session-local, so a consumer must key identity by `(sessionId, id)`, not by `id` alone. `sourceId` is an ordering/lifetime token, not a new run identity on reload.

Subscribe during the host extension factory. To recover after late subscription, emit `{ v: 1 }` on `pi-toolbox:subagents:lifecycle:request` after subscribing. An active publisher responds synchronously with a snapshot. Before session initialization or after shutdown there is no response. A startup snapshot is emitted after restoration regardless of load order. Duplicate requests are safe. There is no polling, callback serialization, stdout write, or BB-specific dependency here.

Upserts are emitted only when projected fields change. The manager publishes queued before invoking the backend, then running, then one terminal state. Queued is a transient real state, not a waiting queue: the fifth concurrent spawn is rejected without a run. A synchronous backend exception can move directly from queued to failed. Consumption, progress text, and repeated cancellation do not emit duplicate lifecycle updates. Backend routing changes can update `harness` without changing run identity.

The spawn tool records its actual Pi `execute` tool-call ID before the first event. Origin metadata survives existing version-1 persistence. The label uses explicit `name`, then `agent`, then `Subagent`. It never falls back to the prompt. Old persisted runs and command-created runs without origin use `Subagent <id>` and omit the tool-call ID. This leaves existing prompt-derived titles in the standalone Pi UI untouched. Explicit labels are caller-supplied display text, not a secret-redaction mechanism; callers must not put credentials in names.

Events exclude prompts, system prompts, transcripts, tool arguments/results, working directories, model output, and error text. They are display data only, never instructions or authorization. Transport adapters should validate versions and fields and forward only this allowlist, not persisted records or spawn result details.

On shutdown, active runs settle cancelled before one clear event. Clear removes the live registry for that source; it does not request deletion of historical transcript items. Late completions cannot reopen cleared runs, and spawns on a closed manager are rejected. On restoration, interrupted queued/running records become failed, while existing terminal states and origin metadata survive. Reconcile the startup snapshot rather than displaying interrupted records as active. Unexpected process death cannot emit clear: the host owns that cleanup.

## BB source findings

Inspected upstream revision: [`66bbc1a2d80bdaba936d9df6cd583953a5f23937`](https://github.com/get-bb/bb/tree/66bbc1a2d80bdaba936d9df6cd583953a5f23937). This is a source-level compatibility assessment, not a claim that the installed provider has this revision or that an end-to-end BB test has passed.

| Source | Verified behavior |
| --- | --- |
| [`plugins/provider-pi/README.md`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/plugins/provider-pi/README.md) | Fire-and-forget extension UI updates, including `setStatus`, are accepted and ignored. |
| [`src/bridge/bb-pi-extension.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/plugins/provider-pi/src/bridge/bb-pi-extension.ts) | Generated extension writes JSONL through FD 3 to the bridge; FD 4 receives bridge messages. No subagent bus subscription exists. |
| [`src/bridge/rpc-session.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/plugins/provider-pi/src/bridge/rpc-session.ts) | `handleChannelMessage` recognizes ready, checkpoint, tool-call, and reply messages, not lifecycle telemetry. RPC stdout events use `handleEvent` and `deliverInOrder`. |
| [`src/delta-translation.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/plugins/provider-pi/src/delta-translation.ts) | Translates Pi tools and turns; `agent_end` clears tool-shape state and emits a turn boundary. No pi-toolbox lifecycle translation exists. |
| [`thread-delta.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/packages/provider-bridge-protocol/src/thread-delta.ts) | `delegation` has `childRef`, `label`, `background`, optional `summary`. `backgroundTask` carries `familyId`, `taskType`, `description`, item `status`, `taskStatus`, and `skipTranscript`. |
| [`provider-claude-code/src/task-translation.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/plugins/provider-claude-code/src/task-translation.ts) | Claude background agents use native `backgroundTask` items with `item.open`, `item.progress`, and `item.close`, and `parentRef` from `tool_use_id`. |
| [`background-task.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/packages/domain/src/background-task.ts) | Recognizes `local_agent` / `local_subagent` and maps task statuses to item statuses. |
| [`delta-assembler.ts`](https://github.com/get-bb/bb/blob/66bbc1a2d80bdaba936d9df6cd583953a5f23937/packages/provider-bridge-protocol/src/assembler/delta-assembler.ts) | Background task progress/completion are thread-scoped; `item.open` still needs a current or explicitly attached previous turn. Thread-attached items survive `finishTurn`. |

## Required BB provider patch (not implemented here)

Use BB's existing native background-agent items. Do not create BB threads, another panel, or fake child transcripts. The verified `backgroundTask` contract can represent these runs without inventing a `childRef` for a child session that BB does not own. Keep the ordinary spawn tool item and attach the background task to it, as Claude does.

1. In `bb-pi-extension.ts`, subscribe to the lifecycle bus during factory registration. Validate and forward the allowlisted payload using the existing FD 3 `writeLine` path, with a new provider-private envelope such as `{ kind: "subagents-lifecycle", event }`. This envelope is a **proposed BB change**, not an existing protocol. Request a snapshot after subscribing and at session readiness; accept the later startup snapshot when pi-toolbox initializes after BB. Do not forward all bus channels, use `setStatus`, or write arbitrary records to RPC stdout.
2. In `rpc-session.ts`, add the corresponding channel-message decoder and forward a validated provider-internal event through ordered delivery to the translator. Keep receiving it while Pi is idle, not only during a prompt. Stdout and FD 3 are separate pipes: ordering within `deliverInOrder` does not guarantee that `tool_execution_start` arrives before a queued upsert. Buffer by the actual Pi `toolCallId` until its spawn item/turn is known, then replay updates in sequence. Do not use the bridge's unrelated `tc-N` proxy IDs or close the run at `tool_execution_end`.
3. In `delta-translation.ts` (preferably a focused lifecycle translator module), keep session-scoped run state separate from per-turn tool-shape state. Use an unambiguous encoding of `(sessionId, run.id)` for `providerItemId` and `familyId`. Set `parentRef` to the known spawn `toolCallId`, `taskType: "local_agent"`, `description: run.label`, and `skipTranscript: false`. Emit one open, progress with a complete shape, and one terminal close. Do not open a second item on snapshot replay. Suggested status mapping follows the existing domain helper:

   | pi-toolbox | BB `taskStatus` | BB item `status` |
   | --- | --- | --- |
   | queued | pending | pending |
   | running | running | pending |
   | completed | completed | completed |
   | failed | failed | failed |
   | cancelled | stopped | interrupted |

4. Reconcile snapshots and clears by session/source. Ignore older sequences within a source and events from retired process lifetimes. A new source can update the same persisted run identity, including interruption-to-failed restoration. Preserve settled transcript items on clear; settle remaining active items as interrupted if shutdown/death prevented terminal telemetry. Never treat every Pi `agent_end` as subagent completion: runs outlive the spawn tool and parent turn. The assembler already supports thread-scoped background updates. For startup/command runs without a current turn, explicitly choose the supported current-or-last attachment or buffer until a real turn exists; don't synthesize a user turn just to display telemetry.
5. Wire process-exit, session reset/switch, and provider disconnect cleanup independently of the bus. Restore the provider's correlation/dedup state on reconnect so persisted items are updated rather than duplicated. Test the installed BB SDK version before selecting `backgroundTask`; older delegation-only builds may need a BB upgrade. Do not silently fall back to a parallel UI.

Required BB tests: real generated-extension forwarding with the fake RPC child; FD/stdout reordering; immediate backend failure; completion after parent `agent_end`; cancel vs completion race; clear vs late event; abrupt process death; reload with restored failed/terminal runs; repeated snapshots; same `run-1` in different sessions; unsupported versions; malformed/oversized payload rejection; native assembler/timeline projection. Keep the existing provider's tests for interactive extension UI and ordinary tools passing.

## Local verification scope

`test/lifecycle.test.ts` exercises the real manager and allowlisted publisher, including failure, cancellation, restoration, observer failure, replay, privacy, and shutdown. `test/extension.integration.test.ts` exercises tool-call correlation, headless delivery, snapshots, sequence ordering, terminal updates, and cleanup through the extension API. These tests do not run a BB provider or prove native rendering. The provider patch and its transport/assembler tests remain the integration gate.
