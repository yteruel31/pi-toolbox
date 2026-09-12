import { readFile, writeFile } from "node:fs/promises";
import { acquireQueuedRedditProfileLock } from "../../src/reddit-queue.js";
import type { ValidatedRedditConfig } from "../../src/reddit-config.js";

const [profileDir, stateDir, marker, holdText] = process.argv.slice(2);
if (!profileDir || !stateDir || !marker || !holdText) throw new Error("worker arguments required");
const config: ValidatedRedditConfig = { profileDir, stateDir, executablePath: "/usr/bin/true", identity: "worker" };
const lock = await acquireQueuedRedditProfileLock(config, { waitTimeoutMs: 5_000, pollIntervalMs: 10 });
try {
  const active = await readFile(marker, "utf8");
  if (active !== "0") throw new Error("cross-process overlap");
  await writeFile(marker, "1", { mode: 0o600 });
  await new Promise((resolve) => setTimeout(resolve, Number(holdText)));
  await writeFile(marker, "0", { mode: 0o600 });
} finally { await lock.release(); }
