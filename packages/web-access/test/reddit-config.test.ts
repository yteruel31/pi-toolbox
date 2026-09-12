import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config.js";
import { acquireRedditProfileLock, RedditConfigError, validateRedditConfig } from "../src/reddit-config.js";

test("reddit config is explicit, absolute, paired and strict", () => {
  const base = parseConfig({}, "/agent"); assert.equal(base.reddit.profileDir, undefined);
  assert.throws(() => parseConfig({ reddit: { profileDir: "/profile" } }, "/agent"), /configured together/);
  assert.throws(() => parseConfig({ reddit: { profileDir: "relative", executablePath: "/bin/true" } }, "/agent"), /absolute/);
  assert.throws(() => parseConfig({ reddit: { profileDir: "/p", executablePath: "/bin/true", discover: true } }, "/agent"), /unsupported/);
});

test("profile validation enforces private directories and a canonical system executable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reddit-config-")); t.after(() => import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })));
  const profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
  const parsed = parseConfig({ reddit: { profileDir: profile, executablePath: "/bin/true" } }, root);
  const valid = await validateRedditConfig(parsed); assert.equal(valid.profileDir, profile); assert.equal((await lstat(valid.stateDir)).mode & 0o077, 0); assert.match(valid.executablePath, /^\/usr\//);
  const executableLink = join(root, "chrome-link"); await symlink("/bin/true", executableLink);
  assert.equal((await validateRedditConfig(parseConfig({ reddit: { profileDir: profile, executablePath: executableLink } }, root))).executablePath, valid.executablePath);
  const ownedExecutable = join(root, "chrome"); await writeFile(ownedExecutable, "x", { mode: 0o700 });
  await assert.rejects(validateRedditConfig(parseConfig({ reddit: { profileDir: profile, executablePath: ownedExecutable } }, root)), (error: RedditConfigError) => error.code === "browser_unavailable");
  await chmod(profile, 0o755); await assert.rejects(validateRedditConfig(parsed), (error: RedditConfigError) => error.code === "profile_unsafe"); await chmod(profile, 0o700);
  const link = join(root, "linked-profile"); await symlink(profile, link);
  await assert.rejects(validateRedditConfig(parseConfig({ reddit: { profileDir: link, executablePath: "/bin/true" } }, root)), (error: RedditConfigError) => error.code === "profile_unsafe");
});

test("profile lock is canonical across concurrent configs for the same profile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reddit-lock-")); t.after(() => import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })));
  const profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
  const firstConfig = await validateRedditConfig(parseConfig({ reddit: { profileDir: profile, executablePath: "/bin/true" } }, join(root, "agent-a")));
  const secondConfig = await validateRedditConfig(parseConfig({ reddit: { profileDir: profile, executablePath: "/bin/false" } }, join(root, "agent-b")));
  const first = await acquireRedditProfileLock(firstConfig); assert.ok(first); assert.equal(await acquireRedditProfileLock(secondConfig), undefined);
  const borrowed = first.borrow(); assert.ok(borrowed); await first.release();
  assert.equal(await acquireRedditProfileLock(secondConfig), undefined); assert.equal(first.borrow(), undefined);
  await borrowed.release(); const second = await acquireRedditProfileLock(secondConfig); assert.ok(second); await second.release();
});
