# @yteruel31/pi-learning

A pull-only, challenge-first technical learning mode for Pi. The learner keeps the initiative, implements the exercises, and owns verbatim notes; Pi researches, proposes a minimal path, gives graduated help on request, and evaluates evidence without completing the learner's solution.

## Install

From npm:

```bash
pi install npm:@yteruel31/pi-learning
```

From this repository:

```bash
pi install ./packages/pi-learning
```

The root meta-package also exposes this extension:

```bash
pi install git:github.com/yteruel31/pi-toolbox@main
```

Restart Pi or run `/reload` after installation.

## Commands

```text
/learn
/learn start <technical topic> :: <concrete intended outcome>
/learn status
/learn note [text]
/learn off
/learn resume learning/<journal>.md
```

- `/learn` or `/learn start` opens guided inputs when Pi has an interactive UI.
- `/learn note` opens a multiline editor when no text is supplied. Use the editor when leading or trailing whitespace matters; Pi trims the outer command argument before dispatch.
- `/learn off` pauses the current mode but keeps its exact phase and checkpoint in the journal.
- `/learn resume` explicitly imports the latest checkpoint into the current session.
- Type `/learn ` and press Tab to autocomplete subcommands. After `/learn resume `, completion proposes journals found under `learning/`.

For non-interactive modes, provide the topic and outcome with the `::` separator.

## Learning contract

While active, the tutor must:

1. run a short adaptive diagnosis tied to the intended outcome;
2. research recent official or primary sources before proposing a curriculum;
3. use roadmap.sh only as a secondary dependency and blind-spot check;
4. expose the smallest useful path and one challenge at a time;
5. prepare a dedicated learner workspace, read completed artifacts there directly, and avoid asking for observable file contents to be copied into chat;
6. wait for learner initiative before progressing, explaining, checking, or quizzing;
7. offer four graduated hint levels without completing the artifact;
8. require a verifiable artifact and the learner's own explanation for module mastery;
9. finish with a novel transfer challenge whose maximum hint level and hint count are no greater than the first module, with at least one lower (or both zero when neither required help).

If web research is unavailable or fails, the tutor must stop curriculum generation and ask for an active research tool or official URLs rather than inventing sources.

## Learning environment

Starting a path prepares a paired environment:

```text
learning/<topic-slug>/     # learner-owned exercise files
learning/<topic-slug>.md   # append-only learning journal
```

The tutor receives the exact absolute workspace path in its active system prompt. It tells the learner where to create exercise files, reads relevant files there when the learner asks for evaluation, and avoids requesting copy-pasted file contents or searching the whole home directory. Learner artifacts remain learner-owned: Pi may inspect them and run requested non-mutating verification, but built-in `edit` and `write` remain blocked.

Existing journals gain their matching workspace automatically on explicit resume or when an active session reloads. Both `learning/` and the workspace are tightened to `0700` locally.

## Journal

The Markdown file is an append-only, human-readable activity history created with private file permissions. The extension tightens the local `learning/` directory to `0700`; an existing or cloned journal must be `0600` before resume or append (`chmod 600 learning/<journal>.md`). Journals are capped at 5 MB. Learner input, verbatim learner notes, AI synthesis, sources, challenges, corrections, checkpoints, and extension events have distinct provenance labels. `/learn note` payloads are stored unchanged inside explicit record markers; ordinary conversation may be summarized only under AI-authored sections.

Portable journal checkpoints omit absolute paths and Pi session identifiers. Because repository-controlled Markdown is untrusted input, `/learn resume` previews the imported topic, outcome, phase, and checkpoint and requires interactive confirmation. Pi session entries remain the source of truth for branch-local operational state. The journal is intentionally cross-branch history, so `/tree` does not erase records from a branch that was left. `/new` and `/fork` start with learning mode disabled; use `/learn resume` to continue deliberately from Markdown.

Use one Pi writer per journal at a time. V1 does not coordinate concurrent sessions writing the same journal. Journals can contain private notes and are not automatically ignored by Git; review them before committing or sharing. Source records accept only HTTP(S) URLs and reject embedded credentials or credential-like query parameters. Resuming also sends the learner-approved checkpoint back to the active model provider.

## Evaluation boundary

While learning mode is active, model calls to built-in `edit` and `write` are blocked. Pi may directly inspect work under the prepared workspace and run learner-requested, non-mutating verification. Demonstrations stay in chat and must not become the completed exercise solution.

This is tutoring policy enforcement, not a filesystem sandbox or learning certification. Mastery and completion records are model-authored evaluations based on observed work and learner responses; they are not independently verified credentials. Bash and third-party tools can have side effects; the system prompt tells the tutor not to use them to bypass the boundary. Use `/learn off` when you intentionally want normal implementation assistance.

## Session behavior

- Reloading or reopening the same session restores state from the selected branch.
- `/tree` restores the checkpoint on the selected branch.
- `/new` and `/fork` start inactive because copied state belongs to the previous session ID.
- Starting a second path is refused while another path is active, including one active on another branch.
- Completing a path or `/learn off` clears the footer indicator while retaining the journal.

## Development

Requires Node.js 22.19 or newer and targets Pi 0.84.2.

```bash
npm install --ignore-scripts
npm run check --workspace @yteruel31/pi-learning
npm run pack:dry --workspace @yteruel31/pi-learning
```
