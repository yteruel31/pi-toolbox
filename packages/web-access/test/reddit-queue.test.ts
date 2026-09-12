import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireQueuedRedditProfileLock, RedditQueueError } from "../src/reddit-queue.js";
import { RedditConfigError, type ValidatedRedditConfig } from "../src/reddit-config.js";

async function fixture(t: test.TestContext, name = "profile"): Promise<ValidatedRedditConfig> {
  const root = await mkdtemp(join(tmpdir(), "reddit-queue-"));
  t.after(() => import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })));
  const profileDir = join(root, name), stateDir = join(root, "state");
  await mkdir(profileDir, { mode: 0o700 }); await mkdir(stateDir, { mode: 0o700 });
  return { profileDir, stateDir, executablePath: "/usr/bin/true", identity: name };
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(path: string): Promise<void> { for (let i = 0; i < 100; i++) { if (await access(path).then(() => true, () => false)) return; await sleep(5); } assert.fail("lock not created"); }

test("arrivals during an active holder remain FIFO and pending capacity uses the same queue", async (t) => {
  const config = await fixture(t), order: number[] = [];
  const holder = await acquireQueuedRedditProfileLock(config);
  const first = acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 1_000, pollIntervalMs: 5, maxPending: 2 }).then(async (lock) => { order.push(1); await sleep(10); await lock.release(); });
  const second = acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 1_000, pollIntervalMs: 5, maxPending: 2 }).then(async (lock) => { order.push(2); await lock.release(); });
  await assert.rejects(acquireQueuedRedditProfileLock(config, { maxPending: 2 }), (error: RedditQueueError) => error.code === "queue_full");
  assert.deepEqual(order, []);
  await holder.release(); await Promise.all([first, second]);
  assert.deepEqual(order, [1, 2]);
});

test("each waiter times out or cancels independently while a holder remains active", async (t) => {
  const config = await fixture(t), holder = await acquireQueuedRedditProfileLock(config), controller = new AbortController();
  let timedOutAcquired = false, nextAcquired = false;
  const timedOut = acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 30, pollIntervalMs: 5 }).then((lock) => { timedOutAcquired = true; return lock; });
  const cancelled = acquireQueuedRedditProfileLock(config, { signal: controller.signal, waitTimeoutMs: 500, pollIntervalMs: 5 });
  const next = acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 60, pollIntervalMs: 5 }).then((lock) => { nextAcquired = true; return lock; });
  controller.abort();
  await assert.rejects(cancelled, (error: RedditQueueError) => error.code === "cancelled");
  await assert.rejects(timedOut, (error: RedditQueueError) => error.code === "queue_timeout");
  await assert.rejects(next, (error: RedditQueueError) => error.code === "queue_timeout");
  assert.equal(timedOutAcquired, false); assert.equal(nextAcquired, false);
  await holder.release(); await sleep(20);
  assert.equal(timedOutAcquired, false); assert.equal(nextAcquired, false);

  // A fresh cycle proves the old queue was cleaned without deleting a newer one.
  const fresh = await acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 100 }); await fresh.release();
});

test("tool-lock timeout, external Chromium busy, and unsafe filesystem errors remain distinct", async (t) => {
  const config = await fixture(t), holder = await acquireQueuedRedditProfileLock(config);
  await writeFile(join(config.profileDir, "SingletonLock"), "owned browser", { mode: 0o600 });
  await assert.rejects(acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 30, pollIntervalMs: 5 }), (error: RedditQueueError) => error.code === "queue_timeout");
  await holder.release();
  await assert.rejects(acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 30, pollIntervalMs: 5 }), (error: RedditQueueError) => error.code === "profile_busy");

  const unsafe = await fixture(t, "removed"); await rm(unsafe.profileDir, { recursive: true });
  await assert.rejects(acquireQueuedRedditProfileLock(unsafe, { waitTimeoutMs: 30 }), (error: RedditConfigError) => error.code === "profile_unsafe");
});

test("different profiles run concurrently", async (t) => {
  const first = await fixture(t, "first"), second = await fixture(t, "second"); let active = 0, maximum = 0;
  await Promise.all([first, second].map(async (config) => { const lock = await acquireQueuedRedditProfileLock(config); try { active++; maximum = Math.max(maximum, active); await sleep(20); active--; } finally { await lock.release(); } }));
  assert.equal(maximum, 2);
});

test("a waiter times out and a cancelled waiter stops while another process holds the lease", async (t) => {
  const config = await fixture(t), marker = join(config.stateDir, "active"); await writeFile(marker, "0", { mode: 0o600 });
  const worker = join(import.meta.dirname, "fixtures", "reddit-queue-worker.ts");
  const child = spawn(process.execPath, ["--import", "tsx", worker, config.profileDir, config.stateDir, marker, "180"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`))); });
  await waitFor(marker); for (let i = 0; i < 100 && await readFile(marker, "utf8") !== "1"; i++) await sleep(5);
  assert.equal(await readFile(marker, "utf8"), "1");
  await assert.rejects(acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 35, pollIntervalMs: 5 }), (error: RedditQueueError) => error.code === "queue_timeout");
  const controller = new AbortController(), cancelled = acquireQueuedRedditProfileLock(config, { signal: controller.signal, waitTimeoutMs: 500, pollIntervalMs: 5 });
  controller.abort(); await assert.rejects(cancelled, (error: RedditQueueError) => error.code === "cancelled");
  await completed;
});

test("independent node processes exclude the same canonical profile", async (t) => {
  const config = await fixture(t), marker = join(config.stateDir, "active"); await writeFile(marker, "0", { mode: 0o600 });
  const worker = join(import.meta.dirname, "fixtures", "reddit-queue-worker.ts");
  const run = () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, config.profileDir, config.stateDir, marker, "40"], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `worker exited ${code}`)));
  });
  await Promise.all([run(), run(), run()]); assert.equal(await readFile(marker, "utf8"), "0");
});
