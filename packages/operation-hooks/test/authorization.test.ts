import { test } from "node:test";
import assert from "node:assert/strict";
import { authorizeOperation, AuthorizationDenied, registerOperationProvider, OPERATION_AUTHORIZATION_CHANNEL, type Operation, type OperationRequest, type SubscriptionBus } from "../src/index.js";
const operation: Operation = { package: "mcp", name: "tools/call", server: "test", toolName: "read", args: { path: "safe" } };
function bus(): SubscriptionBus {
  const listeners = new Set<(data: unknown) => void>();
  return {
    on(channel, listener) { assert.equal(channel, OPERATION_AUTHORIZATION_CHANNEL); listeners.add(listener); return () => { listeners.delete(listener); }; },
    emit(channel, data) { assert.equal(channel, OPERATION_AUTHORIZATION_CHANNEL); for (const listener of listeners) { try { listener(data); } catch { /* Same exception swallowing as Pi. */ } } },
  };
}
test("absent provider is inactive and callbacks are awaited before execution", async () => {
  await authorizeOperation(undefined, operation, {});
  const events = bus(); await authorizeOperation(events, operation, {});
  const order: string[] = [];
  registerOperationProvider(events, () => ({ assess: async () => { await new Promise((resolve) => setTimeout(resolve, 2)); order.push("assessed"); }, result: () => { order.push("result"); } }));
  const ticket = await authorizeOperation(events, operation, {}); order.push("execute"); ticket.result(false); ticket.result(true);
  assert.deepEqual(order, ["assessed", "execute", "result"]);
});
test("vetoes compose restrictively and errors do not expose raw provider details", async () => {
  const events = bus();
  registerOperationProvider(events, () => ({ assess: async () => undefined }));
  const remove = registerOperationProvider(events, () => ({ assess: async () => ({ block: true, reason: "Denied", terminate: true }) }));
  await assert.rejects(authorizeOperation(events, operation, {}), (e: unknown) => e instanceof AuthorizationDenied && e.terminate && e.message === "Denied");
  remove();
  registerOperationProvider(events, () => ({ assess: async () => { throw new Error("raw-secret"); } }));
  await assert.rejects(authorizeOperation(events, operation, {}), (e: unknown) => e instanceof AuthorizationDenied && !e.message.includes("raw-secret"));
});
test("factory exceptions become vetoes even on an exception-swallowing event bus", async () => {
  const events = bus(); registerOperationProvider(events, () => { throw new Error("sensitive error"); });
  await assert.rejects(authorizeOperation(events, operation, {}), AuthorizationDenied);
});
test("invalid gates and malformed verdicts fail closed", async () => {
  const events = bus(); events.on(OPERATION_AUTHORIZATION_CHANNEL, (data) => (data as OperationRequest).provide({} as any));
  await assert.rejects(authorizeOperation(events, operation, {}), AuthorizationDenied);
  for (const verdict of [null, false, { block: false }, { block: true }, { block: true, reason: "no", terminate: "yes" }]) {
    const events = bus(); registerOperationProvider(events, () => ({ assess: async () => verdict as any }));
    await assert.rejects(authorizeOperation(events, operation, {}), AuthorizationDenied);
  }
});
test("timeout and cancellation do not wait for noncooperative evaluators", async () => {
  const events = bus(); registerOperationProvider(events, () => ({ assess: async () => new Promise(() => {}) }));
  await assert.rejects(authorizeOperation(events, operation, {}, undefined, { timeoutMs: 5 }), /timed out/);
  const controller = new AbortController(); const pending = authorizeOperation(events, operation, {}, controller.signal);
  controller.abort(); await assert.rejects(pending, /cancelled/);
  await assert.rejects(authorizeOperation(undefined, operation, {}, controller.signal), /cancelled/);
});
test("operation snapshots are immutable and registration is synchronous", async () => {
  const events = bus(); let request: OperationRequest | undefined;
  events.on(OPERATION_AUTHORIZATION_CHANNEL, (data) => { request = data as OperationRequest; });
  await authorizeOperation(events, operation, {});
  assert.notEqual(request!.operation, operation);
  assert.throws(() => { request!.operation.args.path = "different"; }, TypeError);
  let assessed = false;
  request!.provide({ assess: async () => { assessed = true; } });
  assert.equal(assessed, false);
  assert.equal(operation.args.path, "safe");
});
test("observer failures do not change execution and sanitized denials remove terminal controls", async () => {
  const events = bus(); registerOperationProvider(events, () => ({ assess: async () => undefined, result: () => { throw Error("no"); } }));
  const ticket = await authorizeOperation(events, operation, {}); assert.doesNotThrow(() => ticket.result(true));
  assert.equal(new AuthorizationDenied("\x1b[31mDenied\x1b[0m\n").message, "Denied ");
});
