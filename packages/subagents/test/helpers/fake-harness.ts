/**
 * Deterministic, fully controllable fake harness for core tests. Derived
 * only from the SubagentHarness contract; no Pi/Claude behavior involved.
 */

import type {
  HarnessRunOutcome,
  HarnessRunRequest,
  SubagentHarness,
} from "../../src/core/harness.js";
import type { HarnessKind } from "../../src/shared/types.js";

export class ControlledRun {
  readonly request: HarnessRunRequest;
  readonly promise: Promise<HarnessRunOutcome>;
  aborted = false;
  private resolveFn!: (outcome: HarnessRunOutcome) => void;
  private rejectFn!: (err: unknown) => void;

  constructor(request: HarnessRunRequest, rejectOnAbort: boolean) {
    this.request = request;
    this.promise = new Promise((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    request.signal.addEventListener(
      "abort",
      () => {
        this.aborted = true;
        if (rejectOnAbort) {
          const err = new Error("harness aborted");
          err.name = "AbortError";
          this.rejectFn(err);
        }
      },
      { once: true },
    );
  }

  resolve(outcome: Partial<HarnessRunOutcome> = {}): void {
    this.resolveFn({ finalText: "done", ...outcome });
  }

  reject(err: unknown): void {
    this.rejectFn(err);
  }

  progress(text: string): void {
    this.request.reportProgress(text);
  }
}

export interface FakeHarnessOptions {
  kind?: HarnessKind;
  /** Automatically reject with an AbortError when the run signal aborts. */
  rejectOnAbort?: boolean;
  /** Throw synchronously from run() instead of returning a promise. */
  throwOnRun?: Error;
}

export class FakeHarness implements SubagentHarness {
  readonly kind: HarnessKind;
  readonly runs: ControlledRun[] = [];
  private readonly rejectOnAbort: boolean;
  private readonly throwOnRun: Error | undefined;

  constructor(options: FakeHarnessOptions = {}) {
    this.kind = options.kind ?? "pi";
    this.rejectOnAbort = options.rejectOnAbort ?? false;
    this.throwOnRun = options.throwOnRun;
  }

  run(request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    if (this.throwOnRun) throw this.throwOnRun;
    const controlled = new ControlledRun(request, this.rejectOnAbort);
    this.runs.push(controlled);
    return controlled.promise;
  }

  get last(): ControlledRun {
    const run = this.runs[this.runs.length - 1];
    if (!run) throw new Error("FakeHarness has no runs");
    return run;
  }
}

/** Let queued microtasks (settlement handlers) run. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Manually advanced clock for deterministic timestamps. */
export class ManualClock {
  private ms: number;

  constructor(start = 1_000) {
    this.ms = start;
  }

  now = (): number => this.ms;

  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}
