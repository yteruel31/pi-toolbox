import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { acquireRedditProfileLock, redditProfileLockPath, type RedditProfileLock, type ValidatedRedditConfig } from "./reddit-config.js";

export type RedditQueueFailure = "profile_busy" | "queue_full" | "queue_timeout" | "cancelled";
export class RedditQueueError extends Error {
  constructor(readonly code: RedditQueueFailure) {
    super(code === "profile_busy" ? "The configured Reddit profile is in use by Chromium; close that browser and try again."
      : code === "queue_full" ? "Too many Reddit operations are already waiting for this profile."
      : code === "queue_timeout" ? "Timed out waiting for another Reddit tool operation to release this profile."
      : "Reddit operation was cancelled while waiting for the profile.");
    this.name = "RedditQueueError";
  }
}

export interface RedditQueueOptions { signal?: AbortSignal; waitTimeoutMs?: number; pollIntervalMs?: number; maxPending?: number }
interface Waiter {
  config: ValidatedRedditConfig;
  signal?: AbortSignal;
  deadline: number;
  pollIntervalMs: number;
  resolve(lock: RedditProfileLock): void;
  reject(error: unknown): void;
  abort(): void;
  deadlineTimer?: NodeJS.Timeout;
  pollTimer?: NodeJS.Timeout;
  settled: boolean;
}
interface ProfileQueue { active: boolean; polling: boolean; waiters: Waiter[] }
const queues = new Map<string, ProfileQueue>();
export const REDDIT_QUEUE_WAIT_TIMEOUT_MS = 120_000;
export const REDDIT_QUEUE_MAX_PENDING = 16;

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value!), minimum), maximum) : fallback;
}
function clean(key: string, queue: ProfileQueue): void {
  if (queues.get(key) === queue && !queue.active && !queue.polling && queue.waiters.length === 0) queues.delete(key);
}
function finishWaiter(key: string, queue: ProfileQueue, waiter: Waiter): void {
  if (waiter.settled) return;
  waiter.settled = true;
  if (waiter.deadlineTimer) clearTimeout(waiter.deadlineTimer);
  if (waiter.pollTimer) clearTimeout(waiter.pollTimer);
  waiter.signal?.removeEventListener("abort", waiter.abort);
  const index = queue.waiters.indexOf(waiter);
  if (index >= 0) queue.waiters.splice(index, 1);
  clean(key, queue);
}
async function externalSingletonPresent(config: ValidatedRedditConfig): Promise<boolean> {
  // A Chromium SingletonLock created by the operation holding our own tool lock
  // is not evidence that an unrelated browser owns the profile.
  try { await lstat(redditProfileLockPath(config)); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  try { await lstat(join(config.profileDir, "SingletonLock")); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}
function expireWaiter(key: string, queue: ProfileQueue, waiter: Waiter): void {
  if (waiter.settled) return;
  finishWaiter(key, queue, waiter);
  void externalSingletonPresent(waiter.config).then(
    (external) => waiter.reject(new RedditQueueError(external ? "profile_busy" : "queue_timeout")),
    () => waiter.reject(new RedditQueueError("queue_timeout")),
  );
  runHead(key, queue);
}
function runHead(key: string, queue: ProfileQueue): void {
  if (queue.active || queue.polling) return;
  const waiter = queue.waiters[0];
  if (!waiter) { clean(key, queue); return; }
  if (waiter.settled) { finishWaiter(key, queue, waiter); runHead(key, queue); return; }
  if (waiter.signal?.aborted) { waiter.abort(); return; }
  if (Date.now() >= waiter.deadline) { expireWaiter(key, queue, waiter); return; }
  queue.polling = true;
  void (async () => {
    const lock = await acquireRedditProfileLock(waiter.config);
    queue.polling = false;
    if (waiter.settled || waiter.signal?.aborted || Date.now() >= waiter.deadline) {
      await lock?.release();
      if (!waiter.settled) waiter.signal?.aborted ? waiter.abort() : expireWaiter(key, queue, waiter);
      else { clean(key, queue); runHead(key, queue); }
      return;
    }
    if (lock) {
      // Mark the queue active before removing its head so cleanup cannot detach
      // this live queue from the map and allow a second in-process holder.
      queue.active = true;
      finishWaiter(key, queue, waiter);
      let released = false;
      const queuedLock: RedditProfileLock = {
        borrow: () => lock.borrow(),
        release: async () => {
          if (released) return;
          released = true;
          try { await lock.release(); }
          finally {
            queue.active = false;
            runHead(key, queue);
            clean(key, queue);
          }
        },
      };
      waiter.resolve(queuedLock);
      return;
    }
    waiter.pollTimer = setTimeout(() => runHead(key, queue), Math.min(waiter.pollIntervalMs, Math.max(1, waiter.deadline - Date.now())));
  })().catch((error) => {
    queue.polling = false;
    if (waiter.settled) { clean(key, queue); runHead(key, queue); return; }
    finishWaiter(key, queue, waiter);
    // Configuration/filesystem safety failures retain their typed category.
    waiter.reject(error);
    runHead(key, queue);
  });
}

/**
 * FIFO inside this process and atomic best-effort fairness between processes.
 * Cross-process ordering is intentionally not claimed: contenders poll the same
 * private O_EXCL lock and never remove a foreign or stale lock.
 */
export async function acquireQueuedRedditProfileLock(config: ValidatedRedditConfig, options: RedditQueueOptions = {}): Promise<RedditProfileLock> {
  if (options.signal?.aborted) throw new RedditQueueError("cancelled");
  const key = redditProfileLockPath(config);
  const queue = queues.get(key) ?? { active: false, polling: false, waiters: [] };
  queues.set(key, queue);
  const maxPending = bounded(options.maxPending, REDDIT_QUEUE_MAX_PENDING, 1, 1024);
  if (queue.waiters.length >= maxPending) { clean(key, queue); throw new RedditQueueError("queue_full"); }
  const timeout = bounded(options.waitTimeoutMs, REDDIT_QUEUE_WAIT_TIMEOUT_MS, 1, REDDIT_QUEUE_WAIT_TIMEOUT_MS);
  const pollIntervalMs = bounded(options.pollIntervalMs, 50, 5, 1_000);
  return new Promise<RedditProfileLock>((resolve, reject) => {
    const waiter: Waiter = {
      config, signal: options.signal, deadline: Date.now() + timeout, pollIntervalMs, resolve, reject,
      settled: false,
      abort: () => {
        if (waiter.settled) return;
        finishWaiter(key, queue, waiter);
        reject(new RedditQueueError("cancelled"));
        runHead(key, queue);
      },
    };
    queue.waiters.push(waiter);
    options.signal?.addEventListener("abort", waiter.abort, { once: true });
    waiter.deadlineTimer = setTimeout(() => expireWaiter(key, queue, waiter), timeout);
    runHead(key, queue);
  });
}
