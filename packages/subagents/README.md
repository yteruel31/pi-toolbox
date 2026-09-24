# @yteruel31/pi-subagents

Background subagents for [Pi](https://github.com/badlogic/pi-mono): spawn autonomous work, keep using the parent session, inspect progress, and collect or automatically receive results.

> **Security:** child harnesses run with your normal host permissions. The Claude harness is headless and deliberately uses `bypassPermissions` with `allowDangerouslySkipPermissions`. Only run trusted tasks in trusted working directories.

## Install

```bash
pi install npm:@yteruel31/pi-subagents
```

Restart Pi or run `/reload`. The package requires Node.js 22.19 or newer and Pi 0.87.1 or newer. The Claude Agent SDK is an optional dependency; if it cannot be installed or authenticated, the Pi harness still works and Claude runs fail with a bounded diagnostic.

The full `pi-toolbox` repository remains Git-installable. This scoped package is the independently versioned distribution of its subagents extension.

## Tools

| Tool | Purpose |
| --- | --- |
| `subagent_spawn` | Start a background run and return its `run-N` id immediately. |
| `subagent_agents` | Discover named profiles and show effective routing. |
| `subagent_wait` | Wait for one or more runs and consume their results. |
| `subagent_cancel` | Request cancellation without deleting records. |
| `subagent_check` | Inspect status, bounded activity, and result preview. |
| `subagent_list` | List all session runs in creation order. |

At most four runs are active at once across both harnesses and `/btw`. Results not collected with `subagent_wait` are delivered once when the parent becomes idle.

The bundled [subagents skill](./skills/subagents/SKILL.md) explains profile selection, autonomous prompts, and result collection. Pi discovers it through both the standalone package and the full toolbox; load it with `/skill:subagents`.

Discover profiles first, then use an exact returned name as `agent`. For example, if `reviewer` is available:

```text
subagent_agents({})
subagent_spawn({
  agent: "reviewer",
  name: "path-security-review",
  prompt: "Review this repository for unsafe path handling. Don't edit files. Report concrete findings with file and line references, or state that you found none."
})
```

`agent` selects the profile's system prompt, tools, skills, and configured routing. `name` is only a display title. If `name` exactly matches an existing profile without `agent`, spawn throws an actionable error before creating a run, even with explicit routing arguments. Supply `agent` to select that profile, or choose a different title for an intentionally generic run. Calls with both `agent` and `name` remain valid.

Omit `harness`, `model`, and `reasoning_effort` unless an override is explicitly requested. For generic work, omit `agent` and use a free-form title; generic runs default to Pi. Keep working after spawn and call `subagent_wait` with the returned run id only when its result blocks progress.

Children cannot call subagent/workflow orchestration tools or interactive user-question tools. Give each child a complete, self-contained prompt.

## Harnesses

### Pi

Creates an isolated in-process Pi session with in-memory history. It inherits the parent model and thinking level unless routing or spawn arguments override them. User/package context and skills load, and project resources load only for the trusted current project, but configured parent extensions are disabled in every child; only the package's inline child-safety guard is installed. Child tool calls have independent three-minute inactivity watchdogs. While the child is active, the run detail editor sends continuation messages through `AgentSession.steer()`.

When the parent loads and enables `@yteruel31/pi-guardrails`, that inline guard also assesses `bash`, `read`, `write` and `edit` through a parent-provided callback. Worker Ask is blocked with a reason, never a popup. Run/profile/parent-session attribution stays in the parent's decision history. The existing tool allowlist runs first; no parent extensions or guardrails package are loaded into children. Without guardrails, this optional integration is inactive. This is mistake prevention, not a sandbox, and does not cover other child tools or change the existing subagents transcripts.

### Claude Code

Uses `@anthropic-ai/claude-agent-sdk` in headless streaming-input mode. It applies the requested cwd, model/alias, effort, and named-agent system prompt. The `fable` alias resolves to Claude Fable 5.1; use `claude-fable-5-1` to pin that release explicitly. While active, continuation messages are written to the same query's `AsyncIterable<SDKUserMessage>` input. Claude settings sources are disabled for isolation; `CLAUDE.md`, hooks, MCP configuration, and user/project Claude settings are therefore not loaded into the child. Authentication comes from the local Claude CLI or `ANTHROPIC_API_KEY`.

Claude's effective effort is resolved through the existing `thinking` route field: `off` disables thinking, `minimal` maps to SDK effort `low`, and `low`, `medium`, `high`, `xhigh`, and `max` map one-to-one. A model exposed by SDK discovery does not guarantee that every effort level is accepted for that model. Toolbox passes the selected value through without availability inference, clamping, or retrying; an SDK rejection is reported as a run failure.

## Named agents

Definitions are Markdown files under:

- an installed package directory declared by `pi.subagents.agents`;
- `~/.pi/agent/agents/**/*.md`;
- `<project>/.pi/agents/**/*.md` for trusted projects.

```markdown
---
name: reviewer
description: Review changes for correctness and regressions.
harness: claude
model: sonnet
thinking: medium
effort: high
tools: Read, Grep, Glob
skills:
  - code-review
  - security
---

You are a strict reviewer. Return concrete findings with file references.
```

Agent defaults are resolved per field. `harness`, `model`, and `thinking` apply to either backend. A Claude profile may additionally declare `effort` as one of `low`, `medium`, `high`, `xhigh`, or `max`; for a resolved Claude route it takes priority over that profile's legacy `thinking` value. It does not select the Claude harness by itself. Invalid effort is ignored non-fatally: the profile remains in `subagent_agents`, its catalogue warning is visible there, and resolution falls back to profile `thinking` when present. These frontmatter fields remain flat YAML scalars; the parser does not promise general YAML support beyond the documented `skills` sequences.

The optional `tools` field is a comma-separated exact allowlist. Pi profiles use Pi tool names such as `read`, `grep`, `find`, and `ls`; Claude profiles use Claude Code names such as `Read`, `Grep`, and `Glob`. The selected harness exposes only the listed tools, while the Pi harness still applies its stricter built-in exclusions for orchestration and interactive-question tools. Invalid, empty, duplicate, or oversized tool lists invalidate that agent definition rather than silently broadening access.

The optional `skills` field follows Claude Code's subagent semantics: use a YAML block or flow sequence of skill names, and the full instructions for each listed skill are injected into the child context before its task. Skills resolve through Pi's enabled user, project, settings, and package skill catalog for the child's working directory. Missing skills, unreadable files, and skills with `disable-model-invocation: true` are skipped instead of blocking the run; warnings appear in that run's activity and transcript. Skill hydration happens inside the managed background run, so `subagent_spawn` still returns immediately. Selected preloads are bounded to 32 names, 128 KiB per skill, and 256 KiB total; oversized skills are skipped whole rather than truncated. Pi children can still discover other enabled skills normally; Claude children keep the package's existing `settingSources: []` isolation, so only the explicitly preloaded Pi skills are injected from local configuration.

User definitions replace package definitions; trusted project definitions replace both. Scans are bounded and reject symlink traversal or package paths outside their real package root.

A package can expose agents with:

```json
{
  "pi": {
    "subagents": {
      "agents": ["./agents"]
    }
  }
}
```

The compatibility key `pi-subagents.agents` is also accepted.

## Optional Jev automatic routing

Jev routing is off by default. When enabled, `subagent_spawn` still returns immediately: model discovery, credential resolution, and SDK routing happen inside the managed background run. The run transcript first records a pending route and then the effective backend, model, thinking level, per-field provenance, and any bounded categorical fallback warning.

It fills only route fields that weren't fixed by spawn arguments, trusted project routing, user routing, or an agent definition. It chooses from the current Pi scoped models, or all available Pi models when the scope is empty, plus models reported by Claude Agent SDK discovery. Scoped thinking pins don't restrict Jev, only scoped model membership does. A genuinely fixed available model remains eligible outside the automatic scope; inherited parent defaults do not. Fixed route fields are never overwritten, and incompatible or unavailable results fall back to the ordinary route with a bounded warning.

The SDK request sends only the task prompt, the selected role's name and description, candidate metadata, and compatibility constraints. It doesn't send parent history or read extra files. Calls time out after five seconds, response bodies are capped at 256 KiB, and requests aren't retried. Candidate catalogues above the service's 255-choice limit fall back safely rather than being truncated. Model descriptions are internal selection metadata, not editable Setup fields. Most of each description comes from what the harnesses report at runtime: the Claude Agent SDK's own model description, effort metadata, and adaptive-thinking flag, plus the Pi catalogue's model name, provider, context window, output limit, accepted input, cost, and reasoning flag. Because the Pi catalogue reports a name and numbers but never says what a model is for, a short curated purpose line is added for the models it covers; the Claude SDK's own description is preferred whenever it has one, and `[1m]` long-context aliases resolve to their base model. Those purpose lines were checked on 2026-09-24 against [OpenAI's model guide](https://learn.chatgpt.com/docs/models), [Anthropic's model overview](https://platform.claude.com/docs/en/models/overview), [Anthropic's effort guide](https://platform.claude.com/docs/en/build-with-claude/effort), and the per-model Claude pages. They only describe models a harness already offers and never add a candidate: runtime catalogues remain the source of model availability and accepted effort levels, a model with no curated entry (a newly published one included) is described from its runtime facts alone, and unknown capabilities are represented only by available runtime facts. This integration does not perform live route-quality evaluation.

Use `/subagents`, then Setup, to stage the user-global opt-in and credential source. Nothing, including a key, is written until Save; Cancel discards the draft. API-key input is masked, and Test connection is an explicit action. Supported sources are a syntactically valid environment-variable reference (up to 256 characters; `JEV_API_KEY` and `TYPESAFE_API_KEY` are recommended), Linux Secret Service through `secret-tool`, or an explicitly selected private mode-0600 file outside repositories. Only Environment settings may live below current-user-owned, group-writable ancestors (for example, a mode-0775 `~/.pi`). The immediate settings directory must remain current-user-owned and not group/world writable, the settings file must not be group/world writable, and symlinks are rejected. This exception does not neutralize a writable ancestor: another group member can rename or remove descendants and race settings access. File and keyring settings, and credential files, keep the stricter path policy. Both `enabled` and the environment-variable reference are security-relevant settings: tampering can change whether routing is active and which token is sent to the fixed `api.typesafe.ai` service. It cannot select an attacker endpoint or execute arbitrary code. The dedicated keyring namespace is `application=pi-subagents, service=jev`; keys are passed over stdin, never argv. There's no automatic fallback from keyring to a plaintext file.

On Linux, install `libsecret-tools` and make sure Pi has a session D-Bus plus an unlocked Secret Service collection, such as GNOME Keyring. After Save, run `/reload`; active extension state isn't changed until reload. Never send Jev keys through chat, command arguments, project files, or repository configuration.

## Saved routing

Use `/subagents agents` to edit routes, or write:

- user: `~/.pi/agent/subagents.json`;
- trusted project: `<project>/.pi/subagents.json`.

```json
{
  "version": 1,
  "agents": {
    "reviewer": {
      "harness": "claude"
    }
  }
}
```

Precedence is evaluated independently for harness, model, and thinking: explicit spawn argument > trusted project route > user route > agent default > parent Pi default. A saved `thinking` value therefore overrides profile `effort`; the spawn argument for the same field is `reasoning_effort`. `thinking` is the single routing UI/config field for both Pi thinking and Claude effort—there is no saved `effort` field. A harness-only route can select Claude while retaining model/effort defaults from the profile, without copying them into `subagents.json`.

Parent defaults apply only to Pi. For Claude, unresolved model/thinking values are omitted so the SDK chooses its defaults. In particular, a Claude profile's `model: inherit` deliberately becomes an omitted model with `agent` provenance; it does not pass through or adapt the parent Pi model. Writes are atomic with private file/directory permissions. Untrusted project routes are ignored. Invalid routing files must be explicitly backed up and reset from the routing UI before they can be replaced.

## Commands

- `/subagents` — choose run inspection or routing in TUI mode.
- `/subagents runs` — open the live run overlay.
- `/subagents agents` — open the routing editor.
- `/subagents setup` — open user-global Jev opt-in and credential setup.
- `/btw <question>` — ask a one-off Pi side question using the shared cap. Its answer is shown to the human and persisted as a custom entry, but never enters parent-model context or triggers a parent turn.

Both TUI panels use the full terminal and the active Pi theme. When a spawn supplies both a custom `name` and a named-agent profile, the parent transcript call heading, run lists, and details preserve the custom title and show its origin as `custom title (profile-name)`. With only a profile, the call heading shows `(profile-name)` without exposing the spawn prompt. Run list and detail metadata show the selected thinking level in parentheses after the model when available. In the run list, Enter opens the detailed structured transcript directly. Active Pi and Claude runs show a Pi `Editor`: Enter submits to that existing child, normal multiline/navigation editing stays available, PageUp/PageDown scroll the transcript, `r` refreshes with visible feedback, and `x` opens an in-panel cancellation confirmation (`y`/Enter confirms; `n`/Escape keeps the run active). Outside that confirmation, Escape returns to the list. Settled runs remain inspectable but become read-only. The transcript distinguishes lifecycle, user, assistant, and tool events and retains bounded tool input/output with omission accounting.

A persistent status below Pi's main editor summarizes running, completed, and errored runs and advertises `/subagents`; it remains after settlement until the session has no run records. The same totals are broadcast on the `pi.events` channel `pi-toolbox:subagents:status` as `{ v: 1, counts: RunCounts }` (`running`, `completed`, `error`) whenever the status updates, including in headless sessions with no UI, with `{ v: 1, counts: null }` on shutdown so consumers discard stale counts. The routing panel supports arrows, Tab for scope, Enter to edit, `d` to delete, and Escape. Route editing stays inside the same panel: use arrows or Tab to select a field, left/right to change harness, model, or thinking, Enter to save, and Escape to return to the mapping list. Thinking is the only effort control in the UI and saved configuration; it maps to Claude SDK effort as described above. The model selector uses Pi's scoped models (or all currently available Pi models when no scope is configured) and Claude Agent SDK `supportedModels()`. Selecting a Pi scoped model with a pinned thinking level applies that level to the thinking selector. An existing saved value missing from the current catalogue stays selectable and is marked as saved instead of being silently replaced.

## Development

```bash
npm install
npm run check
npm test
npm run build
npm run pack:dry
```

Opt-in Claude live test:

```bash
PI_SUBAGENTS_CLAUDE_LIVE=1 npm test
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) and [CLEANROOM.md](./CLEANROOM.md).

## License

MIT © Yoann TERUEL

<!-- AI generated -->
