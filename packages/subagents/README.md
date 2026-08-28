# @yteruel31/pi-subagents

Background subagents for [Pi](https://github.com/badlogic/pi-mono): spawn autonomous work, keep using the parent session, inspect progress, and collect or automatically receive results.

> **Security:** child harnesses run with your normal host permissions. The Claude harness is headless and deliberately uses `bypassPermissions` with `allowDangerouslySkipPermissions`. Only run trusted tasks in trusted working directories.

## Install

```bash
pi install npm:@yteruel31/pi-subagents
```

Restart Pi or run `/reload`. The package requires Node.js 22.19 or newer and Pi 0.84.1 or newer. The Claude Agent SDK is an optional dependency; if it cannot be installed or authenticated, the Pi harness still works and Claude runs fail with a bounded diagnostic.

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

Example:

```text
subagent_spawn({
  prompt: "Review this repository for unsafe path handling and report findings.",
  name: "path-security-review",
  harness: "pi",
  working_dir: "/path/to/trusted/project",
  reasoning_effort: "high"
})
```

Children cannot call subagent/workflow orchestration tools or interactive user-question tools. Give each child a complete, self-contained prompt.

## Harnesses

### Pi

Creates an isolated in-process Pi session with in-memory history. It inherits the parent model and thinking level unless routing or spawn arguments override them. User/package context and skills load, and project resources load only for the trusted current project, but configured parent extensions are disabled in every child; only the package's inline child-safety guard is installed. Child tool calls have independent three-minute inactivity watchdogs. While the child is active, the run detail editor sends continuation messages through `AgentSession.steer()`.

### Claude Code

Uses `@anthropic-ai/claude-agent-sdk` in headless streaming-input mode. It applies the requested cwd, model/alias, effort, and named-agent system prompt. While active, continuation messages are written to the same query's `AsyncIterable<SDKUserMessage>` input. Claude settings sources are disabled for isolation; `CLAUDE.md`, hooks, MCP configuration, and user/project Claude settings are therefore not loaded into the child. Authentication comes from the local Claude CLI or `ANTHROPIC_API_KEY`.

## Named agents

Definitions are Markdown files under:

- an installed package directory declared by `pi.subagents.agents`;
- `~/.pi/agent/agents/**/*.md`;
- `<project>/.pi/agents/**/*.md` for trusted projects.

```markdown
---
name: reviewer
description: Review changes for correctness and regressions.
harness: pi
model: anthropic/claude-sonnet-4-5
thinking: high
tools: read, grep, find, ls
skills:
  - code-review
  - security
---

You are a strict reviewer. Return concrete findings with file references.
```

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

## Saved routing

Use `/subagents agents` to edit routes, or write:

- user: `~/.pi/agent/subagents.json`;
- trusted project: `<project>/.pi/subagents.json`.

```json
{
  "version": 1,
  "agents": {
    "reviewer": {
      "harness": "claude",
      "model": "sonnet",
      "thinking": "high"
    }
  }
}
```

Precedence is explicit spawn arguments, project route, user route, agent defaults, then parent Pi defaults. Writes are atomic with private file/directory permissions. Invalid routing files must be explicitly backed up and reset from the routing UI before they can be replaced.

## Commands

- `/subagents` — choose run inspection or routing in TUI mode.
- `/subagents runs` — open the live run overlay.
- `/subagents agents` — open the routing editor.
- `/btw <question>` — ask a one-off Pi side question using the shared cap. Its answer is shown to the human and persisted as a custom entry, but never enters parent-model context or triggers a parent turn.

Both TUI panels use the full terminal and the active Pi theme. When a spawn supplies both a custom `name` and a named-agent profile, run lists and details preserve the custom title and show its origin as `custom title (profile-name)`. In the run list, Enter opens the detailed structured transcript directly. Active Pi and Claude runs show a Pi `Editor`: Enter submits to that existing child, normal multiline/navigation editing stays available, PageUp/PageDown scroll the transcript, `r` refreshes with visible feedback, and `x` opens an in-panel cancellation confirmation (`y`/Enter confirms; `n`/Escape keeps the run active). Outside that confirmation, Escape returns to the list. Settled runs remain inspectable but become read-only. The transcript distinguishes lifecycle, user, assistant, and tool events and retains bounded tool input/output with omission accounting.

A persistent status below Pi's main editor summarizes running, completed, and errored runs and advertises `/subagents`; it remains after settlement until the session has no run records. The same totals are broadcast on the `pi.events` channel `pi-toolbox:subagents:status` as `{ v: 1, counts: RunCounts }` (`running`, `completed`, `error`) whenever the status updates, including in headless sessions with no UI, with `{ v: 1, counts: null }` on shutdown so consumers discard stale counts. The routing panel supports arrows, Tab for scope, Enter to edit, `d` to delete, and Escape. Route editing stays inside the same panel: use arrows or Tab to select a field, left/right to change harness or thinking, type to edit the model, Enter to save, and Escape to return to the mapping list.

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
