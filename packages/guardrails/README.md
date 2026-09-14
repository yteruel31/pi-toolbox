# Pi Guardrails

Mistake prevention for the main agent and in-process Pi workers. Not an OS sandbox.

The package adds `/guardrails`, with Setup, Policies and History in a centered overlay at 90% terminal width. Protection starts **disabled**. Enable it in Setup and save with Ctrl+s. Loading this package alone doesn't activate protection or change Pi's installed runtime. The package isn't published to npm yet.

Requires Node.js 22.19+ with `node:sqlite`, Pi 0.84.2+ and its existing model authentication. No additional system packages, separate API key, context package, daemon or gateway are required. The UI requires native TUI mode. Main approval dialogs also work with a supporting Pi RPC client. Print/JSON and workers never implicitly approve an Ask.

## Coverage

| Actor / operation | Covered |
| --- | --- |
| Main `bash`, `read`, `write`, `edit` tool calls | Yes, when enabled |
| Pi children created by the updated pi-toolbox subagents package | Same four tools, using the parent's evaluator |
| Profile tool allowlist | Unchanged, enforced before guardrails |
| Claude Code backend | No interception; unchanged |
| User `!` / `!!` shell commands | No |
| Other tools, MCP, LSP mutations, external agents, extensions' own I/O | No |
| Scripts/subprocesses started inside an allowed shell call | Only the outer call is assessed |

Shell presets are conservative lexical checks, not a complete shell parser. They scan chained/quoted commands for recognizable risk; unmatched expressions go to model assessment. Aliases, functions, environment expansion, encoded scripts, races, hard links, concurrent filesystem changes and tool argument mutations by later extensions can defeat intent checks. Existing symlinks and ancestors of new file paths are resolved without reading file contents, but there's no filesystem lock between assessment and execution. Trusted extensions and same-user processes can bypass this package. Use an OS sandbox for containment.

The engine protects direct writes/edits to the Pi agent directory, project Pi configuration directory and its own package, and conservatively denies shell references to guardrails/Pi configuration. Change policies through the human UI or an external editor, not agent tool calls. This isn't protection against arbitrary same-user code tampering with the extension or its integration.

## Decisions

Enabled structured policies run first, in this order: **Deny > Ask > Allow**. An Ask or Deny from this pass never reaches the model. A direct self-protection denial cannot be overridden by an Allow policy. Main approvals offer Allow once, Deny, and Deny and stop. The latter also requests Pi turn cancellation; effects from sibling tools already running cannot be undone.

Worker Ask returns a blocked reason to the worker: try a safe alternative or report the blocker. It never opens the parent's UI, queues an approval, or grants permission. More permissive worker policies are possible by setting their actor scope, while retaining stricter main-only rules. Frontmatter `tools` allowlists still run first and cannot be enlarged by a guardrails Allow.

An explicit structured Allow for shell calls must match an exact, simple command. Complex syntax, wrappers or interpreters still require judgment, even if the full command string matches. File Allows can use a component-bounded path prefix. Natural-language restrictions matching the actor/tool/conditions are assessed before a structured Allow applies.

For unresolved calls, the judge gets a new context containing only fixed assessment instructions, applicable natural policies, sanitized candidate arguments/cwd/actor and bounded relevant action history. No skills, conversation, memory, tool schemas, file bodies or tool results are injected. Candidate/history text is untrusted data, not instructions. The output is strict JSON; unknown policy/history references, extra fields, invalid actions, tool calls and incomplete responses fail closed. Matching natural-policy actions can only raise a model verdict's restriction level. Unlike structured matching, identifying a natural-policy match is still model judgment and can be wrong.

The default judge follows the active **parent** Pi model, including changes between calls. It doesn't inherit the worker model. Setup displays the resolved route. A dedicated registered `provider/model-id` is optional and must belong to Pi's session model scope when one exists. Authentication stays in Pi's registry; its resolved credentials are passed only to the native provider, never to the assessment context or history. Native `streamSimple` maps independent thinking levels across provider APIs, rather than silently passing generic reasoning options to raw `complete` APIs.

Judge thinking defaults to **off**, independently of the parent's thinking. Each completion has a 15-second default deadline, no retries, a configurable output-token request cap, a 32,000 streamed-character ceiling (including thinking) and an 8,000-character verdict ceiling. Provider-specific thinking budgets may change the requested total token count; the local deadline/character ceilings still apply. Cancellation stops waiting even if a provider ignores its signal; it can't guarantee cancellation of already billed provider work. Invalid/unavailable/timed-out judgments require main approval by default or block when error behavior is `deny`. Headless calls always block these errors. Approval UI has a five-minute deadline. Storage/path failures block rather than authorize an unrecorded action.

Redacted or omitted candidate arguments cannot be auto-allowed by model judgment. In particular, write/edit bodies and quoted/multiline shell literals are omitted, so routine worker writes need explicit path-scoped Allow policies if they should run without approval. Structured hard rules inspect original arguments locally before redaction.

## Configuration

Global: `~/.pi/agent/guardrails.json` (or Pi's configured agent directory). Project: `<parent cwd>/.pi/guardrails.json` (Pi's configured directory name is respected). Global config owns activation, model, limits and policies. Trusted project config may only add enabled Ask/Deny policies. It cannot override globals, introduce Allows, disable policies or change judge settings. Untrusted project config is ignored. Invalid/unreadable configuration requires approval or blocks, never silently disables protection.

A minimal global example:

```json
{
  "version": 1,
  "enabled": true,
  "thinking": "off",
  "model": "",
  "timeoutMs": 15000,
  "maxOutputTokens": 1024,
  "errorBehavior": "ask",
  "policies": [
    {
      "id": "git-risk",
      "name": "Destructive Git",
      "enabled": true,
      "scope": "both",
      "tools": ["bash"],
      "kind": "structured",
      "conditions": { "preset": "git" },
      "action": "Ask"
    },
    {
      "id": "worker-source-edits",
      "name": "Routine worker source edits",
      "enabled": true,
      "scope": "subagent",
      "tools": ["write", "edit"],
      "kind": "structured",
      "conditions": { "pathPrefix": "src" },
      "action": "Allow"
    }
  ]
}
```

Start with the built-in presets in the UI: destructive Git, destructive files, system changes, production operations and secrets. The minimal example above doesn't implicitly include omitted presets.

Policy fields: unique `id`, `name`, `enabled`, actor `scope` (`main`, `subagent`, `both`), `tools`, `kind` (`structured`, `natural`), `conditions`, `action` (`Allow`, `Ask`, `Deny`) and optional `description` (required for natural policies). Conditions AND together: `preset` (`git`, `files`, `system`, `production`, `secrets`), `pathPrefix` or exact `command`. Relative path prefixes are resolved against the parent's canonical cwd. Path conditions don't match arbitrary shell commands. Empty conditions match all calls in the policy's tool/actor scope. No user-supplied regex runs in the policy engine. Commands over 16,000 characters and paths over 4,096 characters are denied.

A project file has only `version: 1` and `policies`. Project IDs are namespaced as `project.<id>` and collisions are rejected. Global and project files are bounded at 256 KB, with at most 100 policies per file. Config saves use a private temporary file, atomic rename, exclusive lock and revision check, preserving concurrent changes by rejecting stale writes. A crash can leave `guardrails.json.lock`; after confirming no writer is active, remove that lock with an external editor/shell and reopen the UI. No automatic stale-lock stealing occurs.

Policies are edited as validated JSON in Pi's native multiline editor; common enabled/action/actor changes have direct shortcuts. All edits are staged until Ctrl+s and confirmation. Persistent exceptions are explicit Allow policies, not “allow similar for this session” grants; conflicting Ask/Deny policies still win.

## UI

Tab/Shift+Tab switches Setup, Policies and History. The panel uses Pi semantic colors and fills available height, rather than relying on overlay maxHeight alone. Policies and History show list/detail side by side when wide; Enter opens a scrollable detail view on narrow terminals. PgUp/PgDn scrolls detail or Setup help.

Setup uses native settings rows; `m` edits the judge model route. Policies: `e` edits JSON, `n` creates a policy, `p` adds a missing preset, Space toggles enabled, `a` cycles action and `s` cycles actor. `t` assesses a command against the staged policies, as Main or Pi subagent, **without execution, approval or a history entry**. A model-backed test may use provider credits. The result is marked TEST ONLY in detail.

History starts on Current session and combines main plus all linked Pi child runs. `g` toggles Global; `/` searches; `a` cycles actor filters; `d` cycles decision filters (all, automatic, human-approved, attention, denied). Rows show timestamp, a colored decision icon only, actor, tool and operation summary. Green check means automatic Allow, accent check means human Allow once, warning `!` means assessment/review and red cross means blocked/denied. Detail separates policy/model origin, the original verdict, human choice, execution observation, model metadata and valid history references.

Live updates replace an existing entry in place. New events are indicated rather than prepended; `n` refreshes while retaining the selected ID. Global changes from other Pi processes are read on refresh or the next local update. Closing the panel disposes its subscription. Escape discards unsaved changes.

## Local history and privacy

History is in `<agent directory>/guardrails/history.sqlite`, with a 0700 directory and 0600 database. SQLite WAL transactions serialize concurrent writers. Retention is 30 days / 2,000 entries globally, pruned on opening/writing; entries are capped at 24 KB. Old pages may remain allocated for reuse, and removal isn't a guarantee of forensic erasure. Busy storage fails closed. Records are schema-validated and sanitized again when loaded.

Each observed tool call has one generated event ID. Assessment, review, final choice and reported result update that row. “Allowed” doesn't mean executed. `not-observed` stays until Pi reports a result, then becomes `reported-success` or `reported-error`. After interruption, pending/unknown records remain honest observations; they aren't silently marked successful. Other extensions may still block or modify the tool after guardrails allows it. This is a local decision log, **not a tamper-proof security audit**.

Evaluation history is independent of the UI filter: up to six recent same-parent actions plus ten relevant same-target/operation/policy precedents, deduplicated and bounded at 16 KB. Global precedents are restricted to the same canonical parent cwd, not shared across projects. Worktrees or sessions started in different directories are deliberately distinct projects. Human choices and automatic verdicts remain separate fields. Past approvals never become permanent permissions, and automatic decisions don't bootstrap trust.

Session resume reuses Pi's session ID. Fork/clone uses the new ID; original actions remain in Global rather than being falsely attributed to the fork. Tree navigation within one session retains all observed actions in Current session, with a main branch-leaf reference when available. Child entries retain parent session, run/profile and the actual ephemeral child session ID; no fictional persisted child session is created.

File bodies, edit replacements, tool result bodies and model thinking are never persisted by this package. Quoted/multiline shell literals, assignments, recognized credential formats, sensitive options, URL credentials/query strings and terminal control sequences are omitted/redacted before judgment and logging. Redaction is best effort: arbitrary unlabelled secrets in positional shell arguments can't be recognized reliably. Don't put secrets into tool arguments, policy text or command tests. Guardrails does not redact Pi's own session transcript or subagents' existing transcripts.

## Pi child integration

The parent subagents extension sends `pi-toolbox:guardrails:pi-child:v1` with version, pinned parent session ID, run/profile, cwd, cancellation signal and a synchronous `provide` callback. Guardrails returns assessment/result callbacks. No runtime dependency between the packages is required; the structural contract is documented in `src/child-bridge.ts` and subagents' `src/harnesses/pi-assessment-types.ts`.

The inline `pi-subagents-child-safety` factory enforces the existing allowlist first, then calls the optional parent callback. `noExtensions: true` stays intact. Workers receive neither the parent event bus nor configured parent extensions/packages. The guardrails package is not loaded in children. If no provider is registered, the integration is inactive. Multiple providers compose restrictively; provider failure blocks. Shutdown disposes registration, cancels pending judgments and makes already captured gates reject further calls. Claude has no new gate or permission interception.

## Validation

```bash
npm run check --workspace packages/guardrails
npm exec --workspace packages/subagents -- tsc --noEmit
npm run test --workspace packages/subagents -- --maxWorkers=2
npm run smoke:extensions
```

Tests use fake completions, temporary configuration/storage, native Pi themes and resource-loader fixtures. No dangerous commands or live provider calls are executed. Native TUI snapshots cover dark/light themes, wide/narrow/small terminals, full-height framing, icon colors, selection stability and keyboard handling.

Inspired by the workflow in [aliou/pi-guardrails](https://github.com/aliou/pi-guardrails). This implementation has its own policies, judge, history, UI and worker protocol.

<!-- AI generated -->
