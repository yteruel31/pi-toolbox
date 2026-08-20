# Local remote events

Trusted in-process Pi extensions can bridge an active ask flow through `pi.events`. This is an in-process event-bus contract, not a network API. All channels are namespaced to this package and use payload version 1.

## `@yteruel31/pi-ask:started`

Emitted once when a TUI flow opens:

```ts
{
  version: 1;
  flowId: string;             // random UUID, opaque
  toolCallId?: string;
  source: "tool" | "answer" | "answer:again" | "ask:replay" | "ask:resume";
  title?: string;
  questions: Array<{
    id: string;
    label: string;
    prompt: string;
    type: "single" | "multi" | "preview";
    presentedType?: "single" | "multi" | "preview";
    required: boolean;
    options: Array<{
      value: string;
      label: string;
      description?: string;
      preview?: string;
      recommended?: boolean;
    }>;
    freeform?: boolean;       // internal /answer form only
  }>;
  createdAt: number;          // Unix milliseconds
}
```

Consumers must treat `flowId` as the only flow identity and must not infer choices from labels.

## `@yteruel31/pi-ask:submit`

### Answer

```ts
{
  version: 1;
  requestId: string;          // caller-generated, non-empty
  flowId: string;
  response: {
    kind: "answer";
    mode?: "submit" | "elaborate"; // default: submit
    answers: Record<string, {       // canonical question id
      values?: string[];            // canonical declared option values
      customText?: string;
      note?: string;
      optionNotes?: Record<string, string>; // canonical declared value -> note
    }>;
  };
}
```

Example:

```json
{
  "version": 1,
  "requestId": "bridge-42",
  "flowId": "132bc4aa-10d1-4acd-a6e7-a9afe924ee5d",
  "response": {
    "kind": "answer",
    "mode": "submit",
    "answers": {
      "deployment": {
        "values": ["staging"],
        "note": "Use isolated data",
        "optionNotes": { "staging": "Share the URL with QA" }
      },
      "details": { "customText": "Retain logs for seven days" }
    }
  }
}
```

The submitted answer set replaces, rather than merges with, current UI drafts. The package rejects unknown question ids, option values, and option-note values. Single/preview presentation accepts at most one declared/custom selection. Labels and 1-based indices are recomputed from the open canonical form. User-controlled ids and values, including `__proto__`, `constructor`, and `prototype`, are stored in prototype-free records.

### Cancel

Cancellation must be explicit:

```json
{
  "version": 1,
  "requestId": "bridge-43",
  "flowId": "132bc4aa-10d1-4acd-a6e7-a9afe924ee5d",
  "response": { "kind": "cancel" }
}
```

Missing answers, empty objects, labels such as “cancel”, and transport disconnects are not cancellation.

## `@yteruel31/pi-ask:submit-result`

Every syntactically addressable submit receives one acknowledgement.

Success:

```ts
{ version: 1; requestId: string; flowId: string; ok: true }
```

Failure:

```ts
{
  version: 1;
  requestId: string;          // empty when absent/invalid in the request
  flowId: string;             // empty when absent/invalid in the request
  ok: false;
  error: "flow_not_found" | "invalid_request" | "invalid_answer";
  message: string;
}
```

Error meanings:

- `flow_not_found`: no active flow has that id, including a second submission after the first valid submission settled it.
- `invalid_request`: missing/wrong `version`, `requestId`, `flowId`, response kind, mode, or other request-envelope field.
- `invalid_answer`: answers is not an object, an answer field has the wrong type, an id/value is unknown, or selection cardinality is invalid.

Validation failures leave the flow active so the bridge can correct and retry. The first fully valid answer or cancel deactivates the flow synchronously before acknowledgement listeners or UI callbacks run; every later submit is rejected.

## `@yteruel31/pi-ask:completed`

Emitted exactly once when a flow reaches its terminal result, including local TUI submit/cancel, remote submit/cancel, abort, and unexpected UI failure cleanup:

```ts
{
  version: 1;
  flowId: string;
  toolCallId?: string;
  source: "tool" | "answer" | "answer:again" | "ask:replay" | "ask:resume";
  result: AskUserResult;       // exact result documented in contract.md
  completedAt: number;        // Unix milliseconds
}
```

Example listener and submission:

```ts
export default function bridge(pi) {
  pi.events.on("@yteruel31/pi-ask:started", (event) => {
    if (event.version !== 1) return;
    pi.events.emit("@yteruel31/pi-ask:submit", {
      version: 1,
      requestId: crypto.randomUUID(),
      flowId: event.flowId,
      response: {
        kind: "answer",
        answers: { [event.questions[0].id]: { values: [event.questions[0].options[0].value] } }
      }
    });
  });

  return () => {};
}
```

The success acknowledgement and `completed` event may be observed in either order by composed event-bus listeners; their relative ordering is not a compatibility guarantee. Consumers should correlate by `requestId` and `flowId`, handle each completed `flowId` idempotently, and unsubscribe listeners during extension shutdown.
