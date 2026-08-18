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

## Tools

- `subagent_spawn`: start a Pi or Claude Code subagent in the background.
- `subagent_wait`: wait for one or more subagents and collect their output.
- `subagent_cancel`: interrupt running subagents.
- `subagent_check`: inspect one subagent without blocking.
- `subagent_list`: list all tracked subagents.

A maximum of four subagents may run concurrently across both harnesses. Unconsumed results are delivered to the parent session automatically when they settle.

## Commands

- `/subagents`: open the interactive picker and takeover view.
- `/btw [question]`: run a one-off Pi side question without adding its answer to the parent model context.

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
