import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { resolveKey } from "../src/config.js";
import { applySetup, readSetupSnapshot, saveSetup, SetupError, setupErrorMessage, type SetupDraft } from "../src/setup-store.js";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "web-setup-"));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
const draft = (overrides: Partial<SetupDraft> = {}): SetupDraft => ({ provider: "gemini", enabled: true, searchModel: "gemini-3.6-flash", researchModel: "deep-research-preview-04-2026", storage: "file", ...overrides });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("reading setup is side-effect free, including a missing agent directory", () => fixture(async (dir) => {
  const nested = join(dir, "missing");
  const snapshot = await readSetupSnapshot(nested);
  assert.equal(snapshot.config.search.provider, undefined);
  assert.deepEqual(await readdir(dir), []);
}));

test("file save is private, preserves unrelated settings and provider keys, and resolves normally", () => fixture(async (dir) => {
  const path = join(dir, "web-access.json");
  const credentials = join(dir, "web-access.credentials.json");
  const previous = {
    enabled: false,
    search: { provider: "openai", openaiModel: "existing-search" },
    research: { outputDir: join(dir, "reports"), openaiModel: "existing-research", pollIntervalMs: 15000 },
    credentials: { brave: "${EXISTING_BRAVE}", openai: "existing-literal" },
    synthesisModel: "anthropic/old-model", fetch: { javascript: "never" }, cache: { maxEntries: 42 },
  };
  await writeFile(path, JSON.stringify(previous), { mode: 0o644 });
  await chmod(path, 0o644);
  await writeFile(credentials, JSON.stringify({ brave: "brave-fixture", openai: "openai-fixture" }), { mode: 0o600 });
  const snapshot = await readSetupSnapshot(dir);
  await saveSetup(snapshot, draft({ searchModel: "new-search", researchModel: "new-research", synthesisModel: "openai/synthesis" }), "gemini-fixture");
  const actual = await json(path);
  assert.deepEqual(actual, { ...previous, enabled: true, search: { ...previous.search, provider: "gemini", geminiModel: "new-search" }, research: { ...previous.research, geminiModel: "new-research" }, credentials: { ...previous.credentials, gemini: "file:pi-web-access/gemini" }, synthesisModel: "openai/synthesis" });
  assert.deepEqual(await json(credentials), { brave: "brave-fixture", openai: "openai-fixture", gemini: "gemini-fixture" });
  for (const file of [path, credentials]) assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal(await resolveKey((await readSetupSnapshot(dir)).config, "gemini", {}), "gemini-fixture");
  assert.deepEqual((await readdir(dir)).sort(), ["web-access.credentials.json", "web-access.json"]);
}));

test("keep does not touch credential storage, migrate literals or serialize defaults", () => fixture(async (dir) => {
  const path = join(dir, "web-access.json");
  const previous = { credentials: { gemini: "literal-fixture", openai: "$OPENAI_API_KEY", brave: "keyring:pi-web-access/brave" }, synthesisModel: "openai/old" };
  await writeFile(path, JSON.stringify(previous), { mode: 0o600 });
  // Invalid unrelated credentials storage must not be read while keeping a source.
  await writeFile(join(dir, "web-access.credentials.json"), "do not read");
  let stores = 0;
  await saveSetup(await readSetupSnapshot(dir), draft({ provider: "brave", storage: "keep" }), undefined, { storeKeyring: async () => { stores++; } });
  assert.equal(stores, 0);
  assert.deepEqual(await json(path), { credentials: previous.credentials, search: { provider: "brave" } });
  assert.equal(await readFile(join(dir, "web-access.credentials.json"), "utf8"), "do not read");
}));

test("invalid models and keys fail before any write", () => fixture(async (dir) => {
  const snapshot = await readSetupSnapshot(dir);
  for (const bad of ["", "contains spaces", "fixture\x1b", "a".repeat(16385)]) await assert.rejects(saveSetup(snapshot, draft(), bad), /Invalid setup/);
  await assert.rejects(saveSetup(snapshot, draft({ synthesisModel: "missing-provider" }), "fixture"), /Invalid setup/);
  await assert.rejects(saveSetup(snapshot, draft({ searchModel: "has spaces" }), "fixture"), /Invalid setup/);
  assert.deepEqual(await readdir(dir), []);
}));

test("existing model settings can be preserved verbatim even beyond wizard input limits", () => fixture(async (dir) => {
  await writeFile(join(dir, "web-access.json"), JSON.stringify({ search: { geminiModel: "a".repeat(300) } }), { mode: 0o600 });
  const snapshot = await readSetupSnapshot(dir);
  const result = applySetup(snapshot, draft({ storage: "keep", searchModel: snapshot.config.search.geminiModel }));
  assert.equal((result.search as Record<string, string>).geminiModel, "a".repeat(300));
}));

test("unsafe settings and credentials paths fail closed", { skip: process.platform === "win32" }, () => fixture(async (dir) => {
  const path = join(dir, "web-access.json");
  const credentials = join(dir, "web-access.credentials.json");
  const target = join(dir, "target");
  await writeFile(target, "{}", { mode: 0o600 });
  await symlink(target, path);
  await assert.rejects(readSetupSnapshot(dir), /Unsafe/);
  await rm(path);
  const snapshot = await readSetupSnapshot(dir);
  for (const kind of ["symlink", "directory", "permissions", "oversized", "malformed"] as const) {
    if (kind === "symlink") await symlink(target, credentials);
    if (kind === "directory") await mkdir(credentials);
    if (kind === "permissions") { await writeFile(credentials, "{}"); await chmod(credentials, 0o644); }
    if (kind === "oversized") await writeFile(credentials, "x".repeat(65537), { mode: 0o600 });
    if (kind === "malformed") await writeFile(credentials, "secret-fixture-not-json", { mode: 0o600 });
    await assert.rejects(saveSetup(snapshot, draft(), "fixture"), (error: Error) => {
      assert.doesNotMatch(error.message, /secret-fixture/); return true;
    });
    await assert.rejects(lstat(path), { code: "ENOENT" });
    await rm(credentials, { force: true, recursive: true });
  }
  assert.equal(await readFile(target, "utf8"), "{}");
}));

test("shared writable and symlinked parent directories are rejected", { skip: process.platform === "win32" }, () => fixture(async (dir) => {
  const alias = `${dir}-alias`;
  await symlink(dir, alias);
  try { await assert.rejects(saveSetup(await readSetupSnapshot(alias), draft(), "fixture"), /Unsafe/); }
  finally { await rm(alias); }
  await chmod(dir, 0o777);
  await assert.rejects(saveSetup(await readSetupSnapshot(dir), draft(), "fixture"), /Unsafe/);
  assert.deepEqual(await readdir(dir), []);
}));

test("a stale wizard or an external edit during staging never overwrites newer settings", () => fixture(async (dir) => {
  const path = join(dir, "web-access.json");
  const snapshot = await readSetupSnapshot(dir);
  await assert.rejects(saveSetup(snapshot, draft(), "fixture", { beforeCommit: async () => { await writeFile(path, '{"cache":{"maxEntries":3}}', { mode: 0o600 }); } }), /changed since/);
  assert.deepEqual(await json(path), { cache: { maxEntries: 3 } });
  await assert.rejects(saveSetup(snapshot, draft(), "fixture"), /changed since/);
  assert.deepEqual(await readdir(dir), ["web-access.json"]);
}));

test("external credential edits are detected without clobbering provider keys", () => fixture(async (dir) => {
  const credentials = join(dir, "web-access.credentials.json");
  await assert.rejects(saveSetup(await readSetupSnapshot(dir), draft(), "fixture", { beforeCommit: async () => { await writeFile(credentials, '{"brave":"new-fixture"}', { mode: 0o600 }); } }), /changed since/);
  assert.deepEqual(await json(credentials), { brave: "new-fixture" });
  assert.deepEqual(await readdir(dir), ["web-access.credentials.json"]);
}));

test("parallel saves are serialized and stale snapshots rejected", () => fixture(async (dir) => {
  const snapshot = await readSetupSnapshot(dir);
  const results = await Promise.allSettled([saveSetup(snapshot, draft(), "first-fixture"), saveSetup(snapshot, draft({ provider: "brave" }), "second-fixture")]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const saved = await readSetupSnapshot(dir);
  const provider = saved.config.search.provider!;
  assert.equal(await resolveKey(saved.config, provider, {}), provider === "gemini" ? "first-fixture" : "second-fixture");
}));

test("cross-process lock is exclusive and never stolen or deleted", () => fixture(async (dir) => {
  const path = join(dir, "web-access.json.lock");
  await writeFile(path, "other-process", { mode: 0o600 });
  await assert.rejects(saveSetup(await readSetupSnapshot(dir), draft(), "fixture"), /busy/);
  assert.equal(await readFile(path, "utf8"), "other-process");
  assert.deepEqual(await readdir(dir), ["web-access.json.lock"]);
}));

test("keyring failure never falls back or exposes helper errors; intentional file retry succeeds", () => fixture(async (dir) => {
  const snapshot = await readSetupSnapshot(dir);
  let calls = 0;
  await assert.rejects(saveSetup(snapshot, draft({ storage: "keyring" }), "fixture", { storeKeyring: async () => { calls++; throw new Error("private-helper-output"); } }), (error: Error) => {
    assert.match(error.message, /libsecret-tools.*D-Bus.*Private file/);
    assert.doesNotMatch(error.message, /private-helper-output/);
    assert.equal(error.cause, undefined); return true;
  });
  assert.equal(calls, 1); assert.deepEqual(await readdir(dir), []);
  await saveSetup(snapshot, draft({ storage: "file" }), "fixture");
  assert.equal((await readSetupSnapshot(dir)).config.credentials.gemini, "file:pi-web-access/gemini");
}));

test("keyring success selects its explicit reference and leaves private file keys alone", () => fixture(async (dir) => {
  const credentials = join(dir, "web-access.credentials.json");
  await writeFile(credentials, '{"gemini":"old-file-fixture","brave":"keep-fixture"}', { mode: 0o600 });
  let calls = 0;
  await saveSetup(await readSetupSnapshot(dir), draft({ storage: "keyring" }), "new-fixture", { storeKeyring: async (provider, key) => {
    calls++; assert.equal(provider, "gemini"); assert.equal(key, "new-fixture");
  } });
  assert.equal(calls, 1);
  assert.deepEqual(await json(credentials), { gemini: "old-file-fixture", brave: "keep-fixture" });
  assert.equal((await readSetupSnapshot(dir)).config.credentials.gemini, "keyring:pi-web-access/gemini");
}));

test("post-credential settings failure reports partial persistence instead of claiming rollback", () => fixture(async (dir) => {
  const path = join(dir, "web-access.json");
  await assert.rejects(saveSetup(await readSetupSnapshot(dir), draft({ storage: "keyring" }), "fixture", { storeKeyring: async () => {
    await writeFile(path, '{"enabled":false}', { mode: 0o600 });
  } }), /key may already have been stored/);
  assert.deepEqual(await json(path), { enabled: false });
}));

test("read and write failure summaries never include arbitrary errors or malformed file contents", () => fixture(async (dir) => {
  await writeFile(join(dir, "web-access.json"), "private-fixture", { mode: 0o600 });
  await assert.rejects(readSetupSnapshot(dir), (error: Error) => { assert.doesNotMatch(error.message, /private-fixture/); return true; });
  assert.equal(setupErrorMessage(new Error("private-fixture")), new SetupError("write").message);
}));
