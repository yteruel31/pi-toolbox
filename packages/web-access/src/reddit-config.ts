import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { WebConfig } from "./config.js";

export type RedditConfigFailure = "not_configured" | "browser_unavailable" | "profile_unsafe";
export interface ValidatedRedditConfig {
  profileDir: string;
  executablePath: string;
  stateDir: string;
  identity: string;
}
export class RedditConfigError extends Error {
  constructor(readonly code: RedditConfigFailure) {
    super(code === "not_configured" ? "Configure reddit.profileDir and reddit.executablePath in web-access.json."
      : code === "profile_unsafe" ? "The Reddit profile must be a private, owned directory and must not be a symbolic link."
      : "The configured Reddit browser must resolve to a root-owned, non-writable executable under /usr or /opt.");
    this.name = "RedditConfigError";
  }
}

/** Local-only validation. Inspection can avoid creating state directories. */
export async function validateRedditConfig(config: WebConfig, options: { createState?: boolean } = { createState: true }): Promise<ValidatedRedditConfig> {
  const { profileDir, executablePath, stateDir } = config.reddit;
  if (!profileDir || !executablePath) throw new RedditConfigError("not_configured");
  let profile;
  try {
    const info = await lstat(profileDir);
    if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error();
    if (await realpath(profileDir) !== profileDir) throw new Error();
    profile = await stat(profileDir);
  } catch { throw new RedditConfigError("profile_unsafe"); }
  let canonicalExecutable: string;
  try {
    // Explicitly selected distro alternatives are commonly symlinks. Validate the
    // canonical target rather than rejecting that safe packaging convention.
    canonicalExecutable = await realpath(executablePath);
    const info = await stat(canonicalExecutable);
    if ((!canonicalExecutable.startsWith("/usr/") && !canonicalExecutable.startsWith("/opt/")) || !info.isFile() || info.uid !== 0 || (info.mode & 0o111) === 0 || (info.mode & 0o022) !== 0) throw new Error();
  } catch { throw new RedditConfigError("browser_unavailable"); }
  if (options.createState !== false) await ensurePrivateDirectory(stateDir);
  else await validatePrivateDirectoryIfPresent(stateDir);
  const identity = createHash("sha256").update(`${profile.dev}:${profile.ino}\0${canonicalExecutable}`).digest("hex");
  return { profileDir, executablePath: canonicalExecutable, stateDir, identity };
}

async function validatePrivateDirectoryIfPresent(path: string): Promise<void> {
  try { await ensurePrivateDirectory(path, false); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
export async function ensurePrivateDirectory(path: string, create = true): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()) || await realpath(path) !== path) throw new RedditConfigError("profile_unsafe");
}

export function redditProfileLockPath(validated: ValidatedRedditConfig): string { return join(validated.profileDir, ".pi-web-access-reddit.lock"); }
export async function redditProfileIsBusy(validated: ValidatedRedditConfig): Promise<boolean> {
  // Chromium's SingletonLock is normally a symlink; its mere presence matters.
  for (const path of [redditProfileLockPath(validated), join(validated.profileDir, "SingletonLock")]) {
    try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true; }
  }
  return false;
}
export interface RedditProfileLease { release(): Promise<void> }
export interface RedditProfileLock extends RedditProfileLease { borrow(): RedditProfileLease | undefined }
/** Atomic per-profile lock, independent of executable choice and agent state directory. */
export async function acquireRedditProfileLock(validated: ValidatedRedditConfig): Promise<RedditProfileLock | undefined> {
  if (await redditProfileIsBusy(validated)) return undefined;
  const path = redditProfileLockPath(validated);
  let handle;
  try { handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined; throw new RedditConfigError("profile_unsafe"); }
  const created = await handle.stat();
  await handle.close();
  let leases = 1;
  const releaseLease = async (): Promise<void> => {
    leases--;
    if (leases !== 0) return;
    const info = await lstat(path).catch(() => undefined);
    if (info?.isFile() && !info.isSymbolicLink() && info.dev === created.dev && info.ino === created.ino) await unlink(path).catch(() => {});
  };
  const lease = (): RedditProfileLease => {
    let released = false;
    return { release: async () => {
      if (released) return;
      released = true;
      await releaseLease();
    } };
  };
  let ownerReleased = false;
  const owner: RedditProfileLock = {
    borrow: () => {
      if (ownerReleased) return undefined;
      leases++;
      return lease();
    },
    release: async () => {
      if (ownerReleased) return;
      ownerReleased = true;
      await releaseLease();
    },
  };
  return owner;
}
