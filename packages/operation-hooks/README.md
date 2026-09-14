# Pi Operation Hooks

A small authorization protocol shared by operation producers and policy consumers. This library has no Pi extension, policy, model, UI, network access, persistent state, or dependency on guardrails. Loading it does not enable protection.

MCP and web-access describe operations. Guardrails registers an evaluator. Other trusted policy extensions can register their own evaluator without importing either producer.

## Producer

```ts
import { authorizeOperation } from "@yteruel31/pi-operation-hooks";

const ticket = await authorizeOperation(pi.events, {
  package: "mcp",
  name: "tools-call",
  server: resolvedServer,
  toolName: resolvedTool,
  args: toolArguments,
  rootToolCallId: toolCallId,
}, ctx, signal);
try {
  const result = await executeOperation();
  ticket.result(false);
  return result;
} catch (error) {
  ticket.result(true);
  throw error;
}
```

Place the check before the described effect, after resolving its identity. Use the same arguments for assessment and execution. Don't pass authentication headers, resolved API keys, subprocess environment, OAuth callback codes, or tool result bodies. Original tool arguments stay local to trusted evaluators, which must mask sensitive values before model assessment, persistence, or display.

A producer must propagate denial out of the operation instead of catching it as a retryable transport error. A permitted top-level operation does not automatically permit a different nested operation. Emit a separate check for nested effects that need independent policy evaluation. Don't also evaluate the same operation through Pi's `tool_call` event.

## Consumer

```ts
import { registerOperationProvider } from "@yteruel31/pi-operation-hooks";

const unsubscribe = registerOperationProvider(pi.events, (request) => ({
  assess: async (signal) => {
    // Return undefined only when this evaluator permits the operation.
    return { block: true, reason: "This operation requires approval." };
  },
  result: (isError) => { /* record an observation, never its body */ },
}));
```

Register synchronously during extension setup. When installed but not ready, supply a denying evaluator instead of skipping registration. Cancel pending assessments and ensure producers cannot start new operations on retired contexts. Keep a refusing listener while other producers are still draining shutdown; Pi disposes tracked event-bus subscriptions when it tears down the extension runtime. If managing the bus yourself, call `unsubscribe` only after producers are quiescent. `registerOperationProvider` converts factory errors into vetoes because Pi's event bus otherwise swallows listener exceptions.

## Version 1 contract

Channel: `pi-toolbox:operation-authorization:v1`. Each request carries `v: 1`, a unique `id`, an immutable cloned `operation`, opaque trusted producer `context`, optional cancellation `signal`, and synchronous `provide(gate)` callback. Registration must finish before `emit` returns. An asynchronous event listener that calls `provide` later is not supported. Use the registration helper rather than subscribing directly.

Operation fields are `package` (`mcp` or `web-access`), exact `name`, optional resolved `server`, `toolName`, `urls` and `rootToolCallId`, and original `args`. Operation names and URL meaning are owned and documented by each producer. `urls` describes visible destinations, not proof of every request an upstream service might make. An opaque MCP server can perform arbitrary effects behind a single call.

Each gate exposes asynchronous `assess(signal)` and optional synchronous `result(isError)`. Only `undefined` permits continuation. A block is `{ block: true, reason: string, terminate?: boolean }`. The consumer owns human prompting and native cancellation for `terminate`; the producer receives an `AuthorizationDenied` error. Several evaluators compose restrictively: any veto blocks. Missing providers preserve existing producer behavior; malformed gates/verdicts, exceptions, cancellation, and timeouts with a registered evaluator block instead of permitting the effect. Evaluators have a shared six-minute deadline, including human approval. Cancellation stops waiting even when an evaluator ignores its signal, not work it already launched.

The returned ticket records at most one result observation. A reported success is not independent proof of the external effect. Observer failures cannot reverse execution. No ticket is issued after denial, and no result body is sent through the bus. Denial text is terminal-sanitized, but providers must avoid secrets in reasons. Unexpected exception messages are replaced with a fixed safe error.

This is cooperative extension infrastructure, not a sandbox. Trusted extensions and same-user code can bypass it. It doesn't intercept arbitrary sockets, processes, or unrelated tools.

## Validation

`npm run check --workspace packages/operation-hooks` runs typechecking and local tests. Tests use synthetic operations and an in-memory event bus; no external requests or model calls occur.

<!-- AI generated -->
