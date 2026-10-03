import { describe, expect, it } from "vitest";
import { WaitCoordinator } from "../src/core/wait-coordinator.js";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
describe("WaitCoordinator", () => {
  it("defers steering, releases multiple waits, and cleans registrations", async () => {
    const coordinator = new WaitCoordinator();
    const a = coordinator.register("a");
    const b = coordinator.register("b");
    coordinator.deferUserInput();
    expect(coordinator.transitioning).toBe(true);
    expect(a.signal.aborted).toBe(false);
    await tick();
    expect(a.reason).toBe("user-input");
    expect(b.signal.aborted).toBe(true);
    a.dispose(); b.dispose();
    expect(coordinator.size).toBe(0);
  });
  it("does not let stale cleanup remove a new session registration", () => {
    const coordinator = new WaitCoordinator();
    const old = coordinator.register("same");
    coordinator.clear();
    const current = coordinator.register("same");
    old.dispose();
    expect(coordinator.size).toBe(1);
    coordinator.releaseAll("background");
    expect(current.reason).toBe("background");
    current.dispose();
  });
  it("prioritizes genuine abort even after local release", () => {
    const coordinator = new WaitCoordinator();
    const parent = new AbortController();
    const wait = coordinator.register("a", parent.signal);
    coordinator.releaseAll("background");
    expect(parent.signal.aborted).toBe(false);
    parent.abort();
    expect(wait.reason).toBeUndefined();
    wait.dispose();
  });
  it("does nothing without waits and cancels pending callbacks on completion/shutdown", async () => {
    const coordinator = new WaitCoordinator();
    coordinator.deferUserInput();
    expect(coordinator.transitioning).toBe(false);
    const wait = coordinator.register("a");
    coordinator.deferUserInput();
    wait.dispose();
    await tick();
    expect(wait.signal.aborted).toBe(false);
    coordinator.register("b");
    coordinator.deferUserInput();
    coordinator.clear();
    expect(coordinator.transitioning).toBe(false);
    expect(coordinator.size).toBe(0);
    await tick();
  });
});
