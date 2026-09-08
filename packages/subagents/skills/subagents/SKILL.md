---
name: subagents
description: Use subagent tools to delegate self-contained background work, discover named profiles and their configured routing, select a role with agent, and inspect, collect, or cancel runs.
---

# Background subagents

Use subagents for a bounded task that can run independently while you work on something else. Keep small tasks or work requiring an unresolved user decision in the parent session.

## Select the profile, not just a title

Call `subagent_agents({})` to discover available profiles, their descriptions, tools, skills, and effective routing. When a named role is requested, pass its exact discovered name in `subagent_spawn.agent`. If the requested role is missing, report that instead of silently substituting a generic run.

`agent` loads the profile's system prompt, tools, skills, and saved routing. `name` only sets a display title. It doesn't select a profile. A `name` that exactly matches an existing profile without `agent` is rejected before any run starts. Fix the call by supplying `agent`; don't bypass the error by adding `harness` or `model`. For an intentionally generic run, omit `agent` and use a different, free-form title.

Omit `harness`, `model`, and `reasoning_effort` unless an override is explicitly requested. Routing already chooses these values: explicit arguments take precedence over trusted project routing, user routing, profile defaults, then parent defaults. Generic runs default to Pi. A failed Claude run isn't silently retried on Pi.

## Write an autonomous prompt

Give the child the task, relevant context and paths, scope boundaries, constraints, verification requirements, and expected output. Don't assume it has the parent conversation. Children cannot ask the user or delegate further. Resolve blocking decisions first.

Use `working_dir` only when needed. It must be an existing directory inside the trusted current project; it defaults to the parent cwd. Children have normal host permissions, and Claude runs bypass permission prompts. Delegate only authorized work. If multiple workers can edit files, give them disjoint ownership or isolated checkouts; don't have them edit the same files concurrently.

## Spawn, then keep working

For a discovered profile named `reviewer`:

```json
{
  "agent": "reviewer",
  "name": "Path handling review",
  "prompt": "Review packages/subagents/src/agents for unsafe path handling. Read only; don't change files or run live model calls. Return concrete findings with file paths, line numbers, impact, and suggested regression tests. If there are no findings, say so and list what you checked."
}
```

Pass this object to `subagent_spawn`. Keep the returned `run-N` id and continue independent work. Don't immediately wait unless the result is already needed to proceed.

A generic task can use a free-form title without selecting a profile:

```json
{
  "name": "Summarize routing tests",
  "prompt": "Read packages/subagents/test/agents.route-resolver.test.ts. Don't edit files. Summarize the routing precedence covered by its tests and identify missing cases, with test-name references."
}
```

The common mistake is `{"name":"reviewer","prompt":"Review the changes"}`. This does not select `reviewer`; use `agent` as in the first example.

## Collect or inspect results

| Tool | When to use it |
| --- | --- |
| `subagent_wait({"ids":["run-1","run-2"]})` | The results now block progress. Waits for all listed runs and consumes final results in request order. |
| `subagent_check({"id":"run-1"})` | A progress question or diagnosis needs one run's status, bounded activity, and result preview without consuming it. Don't repeatedly poll. |
| `subagent_list({})` | Recover run ids or inspect current-session statuses. This lists runs, not profiles. |
| `subagent_cancel({"ids":["run-2"]})` | Queued or active work is no longer needed. Cancellation keeps records and doesn't undo side effects. |

Use run ids, not profile names or titles, in `id` and `ids`. Uncollected results are delivered once when the parent becomes idle. At most four runs are active at once; additional runs queue. Tool output is bounded, so don't treat a preview as a complete transcript. Check the reported status and evidence before relying on a child's answer; report failures instead of claiming success.

<!-- AI generated -->
