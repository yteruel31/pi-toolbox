export type WaitReleaseReason = "user-input" | "background";

/** Owns only model-facing waits, never child runs or the parent's operation. */
export class WaitCoordinator {
  private waits = new Map<string, { release(reason: WaitReleaseReason): void; dispose(): void }>();
  private deferred: ReturnType<typeof setImmediate> | undefined;

  get transitioning(): boolean { return this.deferred !== undefined; }
  get size(): number { return this.waits.size; }

  register(toolCallId: string, signal?: AbortSignal) {
    if (this.waits.has(toolCallId)) throw new Error(`Duplicate wait: ${toolCallId}`);
    const controller = new AbortController();
    let reason: WaitReleaseReason | undefined;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const registration = {
      signal: controller.signal,
      get reason() { return signal?.aborted ? undefined : reason; },
      release(value: WaitReleaseReason) {
        if (controller.signal.aborted) return;
        reason = value;
        controller.abort();
      },
      dispose: () => {
        signal?.removeEventListener("abort", abort);
        if (this.waits.get(toolCallId) === registration) this.waits.delete(toolCallId);
        if (!this.waits.size) this.cancelDeferred();
      },
    };
    this.waits.set(toolCallId, registration);
    return registration;
  }

  /** Input is pre-queue: this is a bounded deferral, not an acceptance guarantee. */
  deferUserInput(): void {
    if (!this.waits.size || this.deferred) return;
    this.deferred = setImmediate(() => {
      this.deferred = undefined;
      this.releaseAll("user-input");
    });
  }

  releaseAll(reason: WaitReleaseReason): void {
    this.cancelDeferred();
    for (const wait of this.waits.values()) wait.release(reason);
  }

  clear(): void {
    this.cancelDeferred();
    for (const wait of [...this.waits.values()]) {
      wait.release("background");
      wait.dispose();
    }
  }

  private cancelDeferred(): void {
    if (this.deferred) clearImmediate(this.deferred);
    this.deferred = undefined;
  }
}
