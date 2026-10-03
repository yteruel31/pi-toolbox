---
name: ask-user
description: Use ask_user_question for unresolved consequential decisions, permissions, or explicit interviews; otherwise inspect evidence and continue requested work with reversible repository-consistent defaults.
metadata:
  short-description: Structured user decision gate
---

# Structured user decision gate

Use `ask_user_question` only when the next useful action depends on information the user has not supplied and silently choosing would materially alter the requested outcome. Continue routine requested implementation and verification without intermediate reapproval: inspect available evidence, then use small reversible repository-consistent defaults for ordinary technical details.

## Before asking

1. Inspect available code, documents, and tool output first.
2. Separate facts from preferences, and stay within the requested scope.
3. Continue ordinary implementation and checks with the smallest reversible repository-consistent default; do not interrupt for routine architectural details, cosmetic details, or other uncertainty that evidence resolves.
4. If the user already made or delegated the choice explicitly, restate it and continue instead of asking again.
5. Ask only when a consequential choice remains unresolved and missing input would materially change the requested outcome after evidence and reversible defaults cannot resolve it. Product or research scope, evidence thresholds, costly vendor or security choices, and destructive actions are examples, not limits; authorization is always a gate. Preserve explicit interview requests and safety or permission boundaries.

## Good triggers

Ask before choosing among unresolved materially different outcomes when missing input would change the requested result and evidence or a reversible default cannot resolve the choice:

- product behavior, UX direction, migration strategy, public APIs, security controls, deployments, or destructive operations
- research audience, scope, evidence threshold, budget, timeline, or output format; costly vendor/tool choices
- requirements whose alternatives cannot all be satisfied together

Do not make every architectural detail a gate: follow established repository patterns and use a small reversible default when the user has requested implementation and no unresolved consequential or safety decision remains.

When the user asks for an interview or requirements-gathering session, bundle 2-5 closely related questions. Otherwise prefer one focused decision boundary per call. Prevent question spew: do not turn every uncertainty into a form, do not ask speculative follow-ups, and never emit a chain of forms when one decision unlocks the work.

## Payload quality

- Give every question a stable unique id and concise tab label.
- Use `single` for mutually exclusive outcomes, `multi` when choices can coexist, and `preview` only when every option benefits from substantial preview text.
- Keep labels short and explain trade-offs in descriptions.
- Mark a grounded recommendation with `recommended: true`; recommendations are never automatic selections.
- Do not add filler options. The UI already provides **Type your own**.
- Never mark an option recommended merely to force progress.

## After the response

- Treat `cancelled: true` as no decision.
- Preserve normalized values, notes, and `presentedType` metadata.
- For `mode: "elaborate"`, answer the requested clarification directly. Re-ask only `continuation.affectedQuestionIds` if a choice remains unresolved, while retaining `preservedAnswers`.
- Prefer one structured follow-up containing 2-3 newly related unresolved questions over a long sequence of one-question forms.
- Do not re-ask the same trade-off without new evidence.

## Attempt budget

Use at most two focused attempts for one decision boundary. The first attempt may present the full meaningful choice. If it does not resolve the decision, make the second attempt narrower: retain settled facts, remove already-rejected branches, ask only for the smallest remaining distinction, and explain why that distinction blocks progress. Do not respond to an unclear answer by expanding into more questions.

After the second unsuccessful attempt, stop asking. For a high-impact ambiguity, escalate by stating the unresolved choice, what evidence is missing, and what work is blocked. For a low-impact ambiguity that the user delegates, choose the most reversible option and state the assumption.

## Configuration requests

When asked to modify this package's keymaps, notification channels, extraction models, or persisted behavior, read [the configuration guide](../../docs/configuration.md), preserve unrelated settings, and remind the user to run `/reload` after manual file edits.
