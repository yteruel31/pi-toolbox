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

Creates an isolated in-process Pi session with in-memory history. It inherits the parent model and thinking level unless routing or spawn arguments override them. Normal user/package resources load; project resources load only for the trusted current project. Child tool calls have independent three-minute inactivity watchdogs.

### Claude Code

Uses `@anthropic-ai/claude-agent-sdk` in headless mode. It applies the requested cwd, model/alias, effort, and named-agent system prompt. Claude settings sources are disabled for isolation; `CLAUDE.md`, hooks, MCP configuration, and user/project Claude settings are therefore not loaded into the child. Authentication comes from the local Claude CLI or `ANTHROPIC_API_KEY`.

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
---

You are a strict reviewer. Return concrete findings with file references.
```

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

The run overlay supports arrows, Enter, refresh (`r`), cancel (`c`), takeover (`t`), and Escape. The routing overlay supports arrows, Tab for scope, Enter to edit, `d` to delete, and Escape.

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
