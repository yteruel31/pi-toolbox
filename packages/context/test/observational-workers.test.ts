import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { memoryId, parseObserverOutput, runObserver } from "../src/observational/agents/observer.js";
import { parseReflectorOutput, runReflector } from "../src/observational/agents/reflector.js";
import { parseDropperOutput, runDropper } from "../src/observational/agents/dropper.js";
import { observerPrompt } from "../src/observational/agents/prompts.js";
import { defaultCoordinatorThresholds, processObservationalOnce, selectObserverSources } from "../src/observational/coordinator.js";
import { OBSERVATIONS_RECORDED } from "../src/observational/ledger/types.js";

const source = [{ id: "u1", role: "user" as const, text: "hello" }];
const observation = parseObserverOutput('{"observations":[{"text":"User greeted the assistant.","priority":"low","sourceEntryIds":["u1"]}]}', source, "2025-01-01T00:00:00.000Z")[0]!;
describe("observational workers", () => {
  it("validates observer output, deliberate empty, source subsets, and deterministic ids", () => {
    expect(parseObserverOutput('{"observations":[]}', source, "2025-01-01T00:00:00.000Z")).toEqual([]);
    expect(observation.id).toBe(memoryId("observation", observation.text, ["u1"]));
    expect(parseObserverOutput(JSON.stringify({ observations: [{ text: observation.text, priority: "low", sourceEntryIds: ["u1"] }] }), source, "later")[0]!.id).toBe(observation.id);
    expect(() => parseObserverOutput("not json", source, "now")).toThrow();
    expect(() => parseObserverOutput('{"observations":[{"text":"x","priority":"low","sourceEntryIds":["invented"]}]}', source, "now")).toThrow();
  });
  it("strictly validates reflection support and drop pools", () => {
    expect(parseReflectorOutput('{"reflections":[]}', [observation], "now")).toEqual([]);
    expect(parseReflectorOutput(`{"reflections":[{"text":"A greeting occurred.","priority":"low","supportingObservationIds":["${observation.id}"]}]}`, [observation], "now")[0]!.sources.entryIds).toEqual(["u1"]);
    expect(() => parseReflectorOutput('{"reflections":[{"text":"x","priority":"low","supportingObservationIds":["bad"]}]}', [observation], "now")).toThrow();
    expect(parseDropperOutput(`{"ids":["${observation.id}","${observation.id}"]}`, [observation])).toEqual([observation.id]);
    expect(() => parseDropperOutput('{"ids":["bad"]}', [observation])).toThrow();
  });
  it("selects the first bounded visible text batch and excludes hidden, synthetic and tool/image payloads", () => {
    const entries: any[] = [
      { type: "message", id: "hidden", hidden: true, message: { role: "user", content: "secret" } },
      { type: "message", id: "top-custom", customType: "internal", message: { role: "user", content: "secret" } },
      { type: "message", id: "message-custom", message: { role: "user", content: "secret", customType: "internal" } },
      { type: "message", id: "tool", message: { role: "assistant", content: [{ type: "toolCall", text: "tool" }, { type: "image", data: "x" }] } },
      ...Array.from({ length: 70 }, (_, index) => ({ type: "message", id: `m${index}`, message: { role: "user", content: `text-${index}` } })),
    ];
    const selected = selectObserverSources(entries);
    expect(selected).toHaveLength(64); expect(selected[0]!.id).toBe("m0"); expect(selected.at(-1)!.id).toBe("m63");
  });
  it("commits exactly the old observer batch when a message arrives in flight and reoffers the remainder", async () => {
    const branch: any[] = [{ type: "message", id: "m1", message: { role: "user", content: "one" } }]; const appended: any[] = []; let offers = 0;
    let resolve!: (records: any[]) => void; const pending = new Promise<any[]>((done) => { resolve = done; });
    const options: any = { branch: () => branch, append: (type: string, data: any) => { const entry = { type: "custom", id: `e${branch.length}`, customType: type, data }; branch.push(entry); appended.push(entry); return true; }, isAccepting: () => true, runObserver: () => Effect.promise(() => pending), runReflector: () => Effect.succeed([]), runDropper: () => Effect.succeed([]), thresholds: { ...defaultCoordinatorThresholds, reflectorCount: 999, reflectorCharacters: 999999, dropperCount: 999, dropperCharacters: 999999, foldEvents: 999 }, reoffer: () => { offers++; } };
    const running = Effect.runPromise(processObservationalOnce(options)); await Promise.resolve();
    branch.push({ type: "message", id: "m2", message: { role: "user", content: "two" } }); resolve([]); await running;
    expect(appended[0].customType).toBe(OBSERVATIONS_RECORDED); expect(appended[0].data.throughEntryId).toBe("m1"); expect(offers).toBe(1);
    options.runObserver = () => Effect.succeed([]); await Effect.runPromise(processObservationalOnce(options));
    expect(appended[1].data.throughEntryId).toBe("m2");
  });
  it("advances on empty, skips duplicate triggers, and retries after failure without progress", async () => {
    const branch: any[] = [{ type: "message", id: "m1", message: { role: "user", content: "one" } }]; let calls = 0;
    const options: any = { branch: () => branch, append: (type: string, data: any) => { branch.push({ type: "custom", id: "e1", customType: type, data }); return true; }, isAccepting: () => true, runObserver: () => { calls++; return Effect.succeed([]); }, runReflector: () => Effect.succeed([]), runDropper: () => Effect.succeed([]), thresholds: { ...defaultCoordinatorThresholds, reflectorCount: 999, reflectorCharacters: 999999, dropperCount: 999, dropperCharacters: 999999, foldEvents: 999 }, reoffer: () => undefined };
    await Effect.runPromise(processObservationalOnce(options)); await Effect.runPromise(processObservationalOnce(options)); expect(calls).toBe(1);
    branch.splice(1); options.runObserver = () => { calls++; return Effect.fail(new Error("model")); };
    await expect(Effect.runPromise(processObservationalOnce(options))).rejects.toBeDefined(); expect(branch).toHaveLength(1);
    options.runObserver = () => { calls++; return Effect.succeed([]); }; await Effect.runPromise(processObservationalOnce(options)); expect(calls).toBe(3);
  });
  it("runs all agents for valid/empty output and rejects invalid, model failure and timeout without retries", async () => {
    const response = (text: string) => ({ content: [{ type: "text", text }] }) as any;
    const bridge = (effect: any) => ({ complete: vi.fn(() => effect), resolve: vi.fn() }) as any;
    const cases: Array<(bridge: any, timeout?: number) => Effect.Effect<any[], any>> = [
      (b: any, timeout = 100) => runObserver(b, source, "now", timeout),
      (b: any, timeout = 100) => runReflector(b, [observation], [], "now", timeout),
      (b: any, timeout = 100) => runDropper(b, [observation], timeout),
    ];
    for (const run of cases) {
      const valid = bridge(Effect.succeed(response(run === cases[0] ? '{"observations":[]}' : run === cases[1] ? '{"reflections":[]}' : '{"ids":[]}')));
      expect(await Effect.runPromise(run(valid))).toEqual([]); expect(valid.complete).toHaveBeenCalledTimes(1);
      for (const failing of [Effect.succeed(response("not json")), Effect.fail(new Error("model failed")), Effect.never]) {
        const mocked = bridge(failing); await expect(Effect.runPromise(run(mocked, 1))).rejects.toBeDefined(); expect(mocked.complete).toHaveBeenCalledTimes(1);
      }
    }
  });
  it("bounds prompts without splitting Unicode and labels transcript as untrusted", () => {
    const prompt = observerPrompt([{ ...source[0]!, text: "🙂".repeat(100_000) }]);
    expect(Buffer.byteLength(prompt.user)).toBeLessThanOrEqual(48 * 1024);
    expect(prompt.user).not.toContain("�");
    expect(prompt.user).toContain("UNTRUSTED QUOTED DATA");
  });
});
