---
name: subagents
description: "Use subagent tools for useful independent work: spawn bounded tasks, use subagent_collect for relevant ready results at a dependency boundary, use subagent_wait only when needed; wait only for required ids, and never busywork or poll. In print/headless mode wait for required results before exit. Discover named profiles and their configured routing, select a role with agent, and inspect, collect, or cancel runs."
---

# Background subagents

Use subagents for bounded independent work while the parent does useful independent work itself. Keep small tasks or work requiring an unresolved user decision in the parent session; do not blanket-delegate the main task.

## Select the profile, not just a title

Call `subagent_agents({})` to discover available profiles, their descriptions, tools, skills, and effective routing. When a named role is requested, pass its exact discovered name in `subagent_spawn.agent`. If the requested role is missing, report that instead of silently substituting a generic run.

`agent` loads the profile's system prompt, tools, skills, and saved routing. `name` only sets a display title. It doesn't select a profile. A `name` that exactly matches an existing profile without `agent` is rejected before any run starts. Fix the call by supplying `agent`; don't bypass the error by adding `harness` or `model`. For an intentionally generic run, omit `agent` and use a different, free-form title.

Omit `harness`, `model`, and `reasoning_effort` unless an override is explicitly requested. Routing already chooses these values: explicit arguments take precedence over trusted project routing, user routing, profile defaults, then parent defaults. Generic runs default to Pi. A failed Claude run isn't silently retried on Pi. Pass the exact value `auto` only when automatic routing is requested. It lets Jev choose that field and behaves like `inherit` when Jev is off. Pass `inherit` only to force parent Pi values, or Claude SDK defaults. Any other spelling, such as `openrouter/auto`, is a literal model id.

## Write an autonomous prompt

Give the child the task, relevant context and paths, scope boundaries, constraints, verification requirements, and expected output. Don't assume it has the parent conversation. Children cannot ask the user or delegate further. Resolve blocking decisions first.

Use `working_dir` only when needed. It must be an existing directory inside the trusted current project; it defaults to the parent cwd. Children have normal host permissions, and Claude runs bypass permission prompts. Delegate only authorized work. If multiple workers can edit files, give them disjoint ownership or isolated checkouts; don't have parent and child, or two children, mutate the same files concurrently. Use read-only boundaries when ownership cannot be disjoint.

## Spawn, then keep working

For a discovered profile named `reviewer`:

```json
{
  "agent": "reviewer",
  "name": "Path handling review",
  "prompt": "Review packages/subagents/src/agents for unsafe path handling. Read only; don't change files or run live model calls. Return concrete findings with file paths, line numbers, impact, and suggested regression tests. If there are no findings, say so and list what you checked."
}
```

Pass this object to `subagent_spawn`. Keep the returned `run-N` id and continue useful independent work. At the next dependency boundary, collect relevant results that are already terminal once; wait only for ids required to proceed. Don't immediately wait unless the result is already needed.

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
| `subagent_collect({"ids":["run-1"]})` | At one dependency boundary, consume relevant terminal results without waiting. Active runs stay pending. Do not use it to poll. |
| `subagent_wait({"ids":["run-1","run-2"]})` | Those exact results now block the next step. Waits for all listed runs and consumes final results in request order. |
| `subagent_check({"id":"run-1"})` | A progress question or diagnosis needs one run's status, bounded activity, and result preview without consuming it. Don't repeatedly poll. |
| `subagent_list({})` | Recover run ids or inspect current-session statuses. This lists runs, not profiles. |
| `subagent_cancel({"ids":["run-2"]})` | Queued or active work is no longer needed. Cancellation keeps records and doesn't undo side effects. |

Use run ids, not profile names or titles, in `id` and `ids`. If a wait is no longer needed, `/subagents background` releases model-facing waits while children keep running; acknowledge that ongoing work and end the current response rather than immediately waiting again. It is cooperative guidance, not guaranteed immediate main-turn preemption. On new user steering, follow the latest direction instead of re-waiting the old dependency. This does not affect `/btw` or other sibling tools. Never busywork, list/check/collect polling, or artificial keepalive. Uncollected results are delivered once when the parent becomes idle. If no useful independent work remains, give an honest final response while children continue; automatic delivery resumes when idle. In print/headless `pi -p`, wait for results required before process exit; interactive or RPC sessions may yield while no result is needed. At most four runs are active at once; excess spawn attempts are rejected. Tool output is bounded, so don't treat a preview as a complete transcript. Check the reported status and evidence before relying on a child's answer; report failures instead of claiming success.

<!-- AI generated -->
