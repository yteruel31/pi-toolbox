import { Effect, Layer, ManagedRuntime, Semaphore } from "effect";
import { describe, expect, it, vi } from "vitest";
import { makeObservationalCoordinatorLayer, ObservationalCoordinatorService } from "../src/observational/coordinator.js";
import { registerObservationalFeature } from "../src/observational/feature.js";
import { ModelWorkGate, PiModelBridge, SessionGeneration } from "../src/runtime/services.js";
import { OBSERVATIONS_RECORDED } from "../src/observational/ledger/types.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function host() {
  const hooks = new Map<string, Function>();
  const pi = { registerTool: vi.fn(), registerCommand: vi.fn(), on: vi.fn((name: string, handler: Function) => hooks.set(name, handler)) };
  return { pi, hooks };
}
function context(overrides: Record<string, unknown> = {}) {
  return { isIdle: () => true, hasPendingMessages: () => false, getContextUsage: () => ({ percent: 82 }), compact: vi.fn(), ...overrides } as any;
}
const waitFor = async (condition: () => boolean) => {
  for (let index = 0; index < 100 && !condition(); index++) await tick();
  expect(condition()).toBe(true);
};
function realCoordinator(options: { complete: () => Effect.Effect<any, any>; append?: (type: string, data: any) => void; gate?: Semaphore.Semaphore }) {
  const branch: any[] = [{ type: "message", id: "m1", message: { role: "user", content: "one" } }];
  const append = options.append ?? ((type: string, data: any) => branch.push({ type: "custom", id: `e${branch.length}`, customType: type, data }));
  const pi = { appendEntry: vi.fn(append) } as any;
  const ctx = { sessionManager: { getBranch: () => branch } } as any;
  const bridge = { resolve: vi.fn(), complete: vi.fn(options.complete) } as any;
  const gate = options.gate ?? Semaphore.makeUnsafe(1);
  const dependencies = Layer.mergeAll(
    Layer.succeed(PiModelBridge, bridge), Layer.succeed(ModelWorkGate, gate),
    Layer.succeed(SessionGeneration, { id: 1, isCurrent: () => true }),
  );
  const runtime = ManagedRuntime.make(makeObservationalCoordinatorLayer(pi, ctx, { reflectorCount: 999, reflectorCharacters: 999999, dropperCount: 999, dropperCharacters: 999999, foldEvents: 999 }).pipe(Layer.provide(dependencies)));
  return { branch, pi, bridge, gate, runtime };
}
const coordinatorOf = (runtime: ManagedRuntime.ManagedRuntime<any, any>) => runtime.runPromise(Effect.gen(function*() { return yield* ObservationalCoordinatorService; }));

describe("observational lifecycle", () => {
  it("registers turn_end and agent_settled without starting model work", () => {
    const { pi, hooks } = host(); const run = vi.fn();
    registerObservationalFeature(pi as any, { currentHandle: undefined, run } as any);
    expect([...hooks.keys()]).toEqual(["session_before_compact", "turn_end", "agent_settled"]);
    expect(run).not.toHaveBeenCalled();
  });
  it("turn_end is nonblocking and uses the current generation at offer time", () => {
    const { pi, hooks } = host(); let resolve!: () => void;
    const run = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const controller: any = { currentHandle: { run } };
    registerObservationalFeature(pi as any, controller);
    expect(hooks.get("turn_end")!()).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1); resolve();
  });
  it("compacts only eligible current state and guards/reset all completion paths", async () => {
    const { pi, hooks } = host(); const compact = vi.fn();
    const handle: any = { generation: 1, isCurrent: () => true, run: vi.fn(async () => true) };
    const controller: any = { currentHandle: handle };
    registerObservationalFeature(pi as any, controller); const settled = hooks.get("agent_settled")!;
    settled({}, context({ compact })); await tick(); expect(compact).toHaveBeenCalledTimes(1);
    settled({}, context({ compact })); await tick(); expect(compact).toHaveBeenCalledTimes(1);
    compact.mock.calls[0]![0].onError(); settled({}, context({ compact })); await tick(); expect(compact).toHaveBeenCalledTimes(2);
    compact.mock.calls[1]![0].onComplete();
    controller.currentHandle = { ...handle, generation: 2, run: vi.fn(async () => true) };
    settled({}, context({ compact })); await tick(); expect(compact).toHaveBeenCalledTimes(3);
  });
  it("rejects idle, pending, usage, absent-state and stale-generation cases", async () => {
    const { pi, hooks } = host(); const compact = vi.fn();
    const handle: any = { generation: 1, isCurrent: () => true, run: vi.fn(async () => false) };
    const controller: any = { currentHandle: handle }; registerObservationalFeature(pi as any, controller);
    const settled = hooks.get("agent_settled")!;
    settled({}, context({ compact, isIdle: () => false }));
    settled({}, context({ compact, hasPendingMessages: () => true }));
    settled({}, context({ compact, getContextUsage: () => ({ percent: 81 }) }));
    settled({}, context({ compact })); await tick();
    handle.run = vi.fn(async () => true); handle.isCurrent = () => false;
    settled({}, context({ compact })); await tick(); expect(compact).not.toHaveBeenCalled();
  });
  it("resets the guard when compact throws synchronously and performs no model access itself", async () => {
    const { pi, hooks } = host(); const compact = vi.fn().mockImplementationOnce(() => { throw new Error("boom"); });
    const handle: any = { generation: 1, isCurrent: () => true, run: vi.fn(async () => true) };
    registerObservationalFeature(pi as any, { currentHandle: handle } as any); const settled = hooks.get("agent_settled")!;
    settled({}, context({ compact })); await tick(); settled({}, context({ compact })); await tick();
    expect(compact).toHaveBeenCalledTimes(2); expect(handle.run).toHaveBeenCalledTimes(2);
  });
  it("coalesces pending offers and processes the latest authored branch with monotonic progress", async () => {
    let release!: (value: any) => void;
    const first = new Promise((resolve) => { release = resolve; });
    const fixture = realCoordinator({ complete: () => fixture.bridge.complete.mock.calls.length === 1 ? Effect.promise(() => first) : Effect.succeed({ content: [{ type: "text", text: '{"observations":[]}' }] }) });
    const coordinator = await coordinatorOf(fixture.runtime); coordinator.offer();
    await waitFor(() => fixture.bridge.complete.mock.calls.length === 1);
    for (let index = 2; index <= 20; index++) { fixture.branch.push({ type: "message", id: `m${index}`, message: { role: "user", content: `${index}` } }); coordinator.offer(); }
    release({ content: [{ type: "text", text: '{"observations":[]}' }] });
    await waitFor(() => fixture.pi.appendEntry.mock.calls.length === 2 && coordinator.status().state === "idle");
    const events = fixture.branch.filter((entry) => entry.customType === OBSERVATIONS_RECORDED);
    expect(fixture.bridge.complete).toHaveBeenCalledTimes(2); expect(events.map((entry) => entry.data.clock)).toEqual([1, 2]);
    expect(events.map((entry) => entry.data.throughEntryId)).toEqual(["m1", "m20"]);
    await fixture.runtime.dispose();
  });
  it("shares the model work gate and never overlaps persistent consolidation", async () => {
    const gate = Semaphore.makeUnsafe(1); let release!: () => void; let held = false; let overlap = false;
    const persistent = Effect.runPromise(gate.withPermits(1)(Effect.promise(() => new Promise<void>((resolve) => { held = true; release = resolve; })).pipe(Effect.tap(() => Effect.sync(() => { held = false; })))));
    await waitFor(() => held);
    const fixture = realCoordinator({ gate, complete: () => Effect.sync(() => { overlap ||= held; return { content: [{ type: "text", text: '{"observations":[]}' }] }; }) });
    const coordinator = await coordinatorOf(fixture.runtime); coordinator.offer(); await tick();
    expect(fixture.bridge.complete).not.toHaveBeenCalled(); release(); await persistent;
    await waitFor(() => fixture.bridge.complete.mock.calls.length === 1 && coordinator.status().state === "idle");
    expect(overlap).toBe(false); await fixture.runtime.dispose();
  });
  it("disposes during a pending native model promise without delayed writes or status mutation", async () => {
    let resolve!: (value: any) => void; const pending = new Promise((done) => { resolve = done; });
    const fixture = realCoordinator({ complete: () => Effect.promise(() => pending) }); const coordinator = await coordinatorOf(fixture.runtime);
    coordinator.offer(); await waitFor(() => fixture.bridge.complete.mock.calls.length === 1); const before = coordinator.status();
    await fixture.runtime.dispose(); expect(coordinator.offer()).toBe(false);
    resolve({ content: [{ type: "text", text: '{"observations":[]}' }] }); await tick(); await tick();
    expect(fixture.pi.appendEntry).not.toHaveBeenCalled(); expect(coordinator.status()).toEqual(before);
  });
  it("reports append rejection as append failure without transcript or model text", async () => {
    const fixture = realCoordinator({ complete: () => Effect.succeed({ content: [{ type: "text", text: '{"observations":[]}' }] }), append: () => { throw new Error("private transcript model output"); } });
    const coordinator = await coordinatorOf(fixture.runtime); coordinator.offer(); await waitFor(() => coordinator.status().state === "failed");
    expect(coordinator.status().lastErrorCategory).toBe("append"); expect(JSON.stringify(coordinator.status())).not.toMatch(/private|transcript|output/);
    await fixture.runtime.dispose();
  });
});
