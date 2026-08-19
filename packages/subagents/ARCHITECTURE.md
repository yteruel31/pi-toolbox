# Architecture — `@yteruel31/pi-subagents`

The implementation separates the run state machine from Pi, Claude, filesystem, and terminal adapters. Environment-shaped behavior reaches the core through injected contracts, so lifecycle and race behavior remain deterministic in offline tests.

## Module map

```text
src/
  shared/      plain value types, bounded errors/text/logs
  core/        RunManager and harness contract
  agents/      secure discovery, route resolution, atomic routing storage
  harnesses/   concrete Pi and Claude Agent SDK adapters
  tui/         pure reducers/view models plus concrete Pi overlays
  extension.ts Pi composition root, tools, commands, persistence, delivery
```

`shared` has no environment dependency. `core` depends only on `shared`. The concrete adapters depend inward on those contracts. `extension.ts` is the only session-level composition root.

## RunManager

One manager exists per parent Pi session. It owns:

- a global four-run active cap shared by Pi, Claude, and `/btw`;
- monotonic `run-N` identifiers restored across session reloads;
- exactly-once settlement under completion, cancellation, shutdown, and late-result races;
- bounded activity plus a structured status/user/assistant/tool transcript with dropped-entry accounting;
- an optional active-message control owned until settlement and disposed exactly once;
- bounded diagnostics, output, model metadata, and previews;
- explicit result consumption (`none`, `waited`, `delivered`, `suppressed`);
- wait reservations that prevent auto-delivery from racing an explicit wait;
- deterministic creation and settlement ordering;
- serialized state and a delivery queue, without Pi imports.

The manager observes both branches of every harness promise. Harness failures therefore cannot become unhandled background rejections.

### Delivery and persistence

A normal result exits exactly once through `subagent_wait` or automatic delivery. `/btw` starts with `suppressed` consumption and is never model-delivered.

The adapter writes `PersistedRunState` through `pi.appendEntry`, which does not enter LLM context. On restore, settled consumption remains intact. Previously active processes are not resumed; their records become explicit interrupted failures and are delivered once.

The manager signals when delivery is possible. The adapter drains only while Pi is idle, batches in settlement order, and injects one `followUp` custom message with `triggerTurn: true`. An explicit wait reservation removes its run from that queue.

## Harness contract

```ts
interface SubagentHarness {
  readonly kind: "pi" | "claude";
  readonly supportsActiveMessages: boolean;
  run(request: HarnessRunRequest): Promise<HarnessRunOutcome>;
}

interface HarnessActiveControl {
  sendMessage(text: string): Promise<void>;
  dispose(): void | Promise<void>;
}
```

A request includes prompt, optional named-agent system prompt, resolved cwd/model/thinking, cancellation, bounded progress/transcript callbacks, effective-model reporting, and a one-time active-control ownership handoff. `RunManager.sendMessage()` rejects empty, unknown, settled, unsupported, not-ready, and settlement-racing submissions. A harness owns per-call resource cleanup and must settle after cancellation; manager and harness cleanup share idempotent controls so the underlying session/query is disposed once.

### Pi harness

The Pi adapter creates an isolated in-process session with `SessionManager.inMemory`. It resolves requested models against the parent's model-registry facade through a narrow adapter, passes the full resolved model plus inherited thinking, and lets `createAgentSession` construct its canonical auth/provider runtime. It uses a trust-gated resource loader. Child tools matching subagent, workflow, multi-tool orchestration, or interactive-question names are excluded both initially and dynamically.

Each child tool call receives its own inactivity timer. Only progress from the same call resets that timer. The child resource loader sets `noExtensions: true`, so user, project, and package extensions from the parent are never executed; only the inline child-safety factory is loaded. The public `AgentSession.steer()` method supplies active input while the prompt is running. Agent events produce bounded assistant and tool start/update/end transcript records, including serialized arguments and results. Abort, listener removal, timers, active-control closure, child session disposal, and prompt rejection are handled through one cleanup path.

### Claude harness

The Claude adapter lazily loads `@anthropic-ai/claude-agent-sdk`, bridges cancellation to a per-call controller, and starts `query()` with a bounded producer implementing `AsyncIterable<SDKUserMessage>`. Accepted continuation messages enter that same producer; result accounting keeps the query alive only while accepted turns remain. The adapter consumes the query iterator once, closes it once, captures assistant/tool input/progress/result records, and maps the latest SDK result/model usage into the shared result shape. It uses the stock Claude Code system prompt plus the selected named-agent prompt.

Headless execution uses `bypassPermissions` and `allowDangerouslySkipPermissions`. `settingSources: []` and `persistSession: false` prevent user/project Claude settings, hooks, and persisted child transcripts from altering the run. Missing SDK, executable, auth, incompatible SDK, result, and iterator failures become bounded typed diagnostics.

## Agent discovery and routing

Discovery happens only for `subagent_agents`, spawn resolution, or routing UI refresh. Sources merge package → user → trusted project.

Package roots come from Pi's `SettingsManager` and `DefaultPackageManager`, not guessed cache paths. Package settings preserve effective user/project order and honor `autoload: false`. Manifest agent paths must remain within a real non-symlink package root. User/project scans use fixed depth, directory, file, per-file byte, and aggregate-byte limits.

`FileRoutingStore` reads user and trusted-project `subagents.json`, rejects unsafe paths/symlinks, preserves unknown fields, writes atomically with mode `0600` under mode `0700` directories, and requires explicit backup/reset for invalid files.

Route precedence is field-by-field:

1. explicit spawn arguments;
2. trusted project mapping;
3. user mapping;
4. named-agent frontmatter;
5. parent defaults (Pi harness).

Each resolved field retains provenance for display.

## Pi extension adapter

The default factory only registers tools, commands, and handlers. It starts no child process, watcher, or timer before `session_start`.

On session start it restores state and builds both harnesses plus the manager. The six tools use TypeBox schemas and `StringEnum` values. Tool text is bounded; `subagent_wait` reports nested usage to Pi. Working directories must exist, resolve inside the trusted current project, and cannot escape through symlinks.

`session_shutdown` clears UI state, aborts all active runs, disposes harness resources through cancellation, and drops session closures idempotently.

## TUI

Reducers and view models are terminal-independent. Concrete bindings translate Pi keys with `matchesKey`, call `requestRender`, keep every line width-bounded, subscribe to live manager changes, and dispose subscriptions exactly once.

`/subagents runs` opens a fresh full-terminal overlay. Enter moves directly from the list to a bounded structured transcript; Escape returns to the list and then closes. Active runs embed the official Pi `Editor`, with container-level `Focusable` propagation, while settled/unsupported runs show an explicit read-only reason. PageUp/PageDown maintain an entry-level scroll offset; new events follow only at the tail. Plain `r` refreshes with a visible notice. Plain `x` enters a confirmation state rendered inside the same overlay before other input is forwarded to the editor; `y`/Enter confirms and `n`/Escape dismisses it, avoiding nested Pi dialogs over the full-screen panel.

`/subagents agents` opens a fresh full-terminal routing overlay with user/project scope, edit/delete, trust gating, and explicit invalid-file backup/reset. The route field editor is an internal panel state rather than a nested `ctx.ui.select`/`ctx.ui.editor` flow, so Enter transitions within the same overlay and Escape returns to the mapping list. Overlays are not reused after close.

The extension status slot is derived only through `tui/status.ts`: running is queued + running, completed is completed, and error is failed + cancelled. It persists while any run record exists and includes the `/subagents` discovery hint.

`/btw` uses the same manager and Pi harness with automatic delivery disabled. The answer is persisted in a custom entry and shown through UI notification, never `sendMessage`.

## Packaging

The npm package is MIT-licensed ESM for Node 22.19+. Pi is a required peer. `pi-ai`, `pi-tui`, and TypeBox are runtime dependencies. The Claude Agent SDK is optional. Pi loads `src/extension.ts` through the package's `pi.extensions` manifest.

Release gates are typecheck, offline tests, build, dry-run pack, unpack/install smoke test, and the clean-room source audit in `CLEANROOM.md`.
