# pi-subagents

Spawn and manage autonomous background subagents from Pi. The extension supports two harnesses:

- `pi`: an in-process Pi session that inherits the current model, thinking level, tools, and configuration by default.
- `claude`: Claude Code through `@anthropic-ai/claude-agent-sdk`, using the installed `claude` executable and its existing authentication.

This package adapts the subagents extension from [davis7dotsh/my-pi-setup at `73bf4d8`](https://github.com/davis7dotsh/my-pi-setup/tree/73bf4d826f39b5cab6b7865e706ba4a2669629ca/extensions/subagents) for Pi Toolbox. See [`NOTICE`](./NOTICE) for provenance and redistribution status.

## Installation

Install Pi Toolbox to load the package:

```bash
pi install git:github.com/yteruel31/pi-toolbox
```

The Claude harness requires Claude Code to be installed and authenticated:

```bash
claude --version
```

## Named agents

The extension discovers Markdown agent definitions recursively from:

- User scope: `~/.pi/agent/agents/**/*.md`
- Trusted project scope: `<cwd>/.pi/agents/**/*.md`

Project definitions win when both scopes define the same agent name. Each file uses YAML frontmatter for its name and description, followed by the agent system prompt:

```md
---
name: reviewer
description: Review changes for correctness and regressions.
---

You are a strict code reviewer.
```

Select a named agent with `subagent_spawn.agent`. Its system prompt and saved routing are applied automatically. Explicit `harness`, `model`, or `reasoning_effort` parameters override the saved routing for that run. The parent model can call `subagent_agents` to discover profile names and routing only when needed; the catalog is not injected into unrelated model turns.

Without a named agent or explicit routing, the extension uses the `pi` harness and inherits the parent model and thinking level.

## Agent routing

Run `/subagents` and open **Agent routing**, or use `/subagents agents` directly. The view lists resolved user and project agents and supports:

- `↑`/`↓`: select an agent
- `Tab`: switch between user and project mapping scope
- `Enter`: assign harness, model, and thinking
- `d`: remove the selected scope's mapping
- `Esc`: close

Mappings are stored separately from agent definitions:

- User mappings: `~/.pi/agent/subagents.json`
- Trusted project mappings: `<cwd>/.pi/subagents.json`

Project mappings replace user mappings for the same agent. An omitted field uses the default: `pi` for the harness, the parent model for a Pi child, and the parent thinking level for a Pi child. Claude model shortcuts include `fable`, `sonnet`, `opus`, and `haiku`; full model IDs remain supported. Mapping files are written with user-only permissions. Invalid mapping files are ignored with a warning; the routing panel can back them up and reset them before editing.

```json
{
  "version": 1,
  "agents": {
    "reviewer": {
      "harness": "claude",
      "model": "opus",
      "thinking": "high"
    },
    "scout": {
      "harness": "pi",
      "model": "anthropic/claude-haiku-4-5",
      "thinking": "low"
    }
  }
}
```

Project agent definitions and mappings are ignored when Pi does not trust the project or when the project `.pi`/`agents` path crosses a symlink boundary.

## Tools

- `subagent_spawn`: start a named or ad-hoc Pi/Claude Code subagent in the background.
- `subagent_agents`: list named agents and their effective routing on demand.
- `subagent_wait`: wait for one or more subagents and collect their output.
- `subagent_cancel`: interrupt running subagents.
- `subagent_check`: inspect one subagent without blocking.
- `subagent_list`: list all tracked subagents.

A maximum of four subagents may run concurrently across both harnesses. Unconsumed results are delivered to the parent session automatically when they settle.

Example named spawn:

```json
{
  "agent": "reviewer",
  "prompt": "Review the current branch and report actionable findings.",
  "name": "Review current branch"
}
```

## Commands

- `/subagents`: choose between running-subagent inspection and agent routing.
- `/subagents runs`: open the running-subagent picker and takeover view directly.
- `/subagents agents`: open agent routing directly.
- `/btw [question]`: run a one-off Pi side question without adding its answer to the parent model context.

`/btw` always uses the Pi harness and inherits the parent model and thinking level.

## Permissions and isolation

Subagents are autonomous and run with the selected harness's normal host permissions. Only use trusted working directories. Child sessions cannot spawn more subagents or workflows and cannot ask the user interactive questions.

Claude Code runs headlessly with permission prompts bypassed. Pi child sessions load normal global/package resources and only load project resources when Pi trusts the project.

## Development

```bash
npm install
npm run check
npm test
npm run pack:dry
```

The live Claude test is opt-in and uses the local Claude Code account:

```bash
npm run test:live
```
