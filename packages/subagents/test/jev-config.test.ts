import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultJevCredentialPath, jevStorageErrorMessage, readJevConfig, readJevSetupSnapshot, resolveJevKey, saveJevSetup, testJevConnection } from "../src/agents/jev-config.js";
import { ensureSafePath } from "../src/agents/jev-storage.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
async function root() { const value = await mkdtemp(join(tmpdir(), "pi-subagents-jev-")); cleanup.push(value); return value; }

describe("Jev setup storage", () => {
  it("writes private config and credential files only when saved", async () => {
    const base = await root(), agentDir = join(base, "agent"), credential = defaultJevCredentialPath(agentDir);
    await saveJevSetup({ agentDir, enabled: true, source: "file", reference: credential, key: "secret-value" });
    expect(await readJevConfig(agentDir)).toEqual({ version: 1, enabled: true, credential: { source: "file", value: credential } });
    expect(await resolveJevKey((await readJevConfig(agentDir))!)).toBe("secret-value");
    if (process.platform !== "win32") { expect((await stat(credential)).mode & 0o777).toBe(0o600); expect((await stat(join(agentDir, "subagents-jev.json"))).mode & 0o777).toBe(0o600); }
    expect(await readFile(join(agentDir, "subagents-jev.json"), "utf8")).not.toContain("secret-value");
  });

  it("retains reopened file and keyring credentials without reads or writes", async () => {
    const base = await root(), agentDir = join(base, "agent"), credential = defaultJevCredentialPath(agentDir);
    await saveJevSetup({ agentDir, enabled: true, source: "file", reference: credential, key: "stored" });
    const snapshot = await readJevSetupSnapshot(agentDir); const before = await readFile(credential, "utf8");
    await saveJevSetup({ agentDir, snapshot, enabled: false, source: "file", reference: credential });
    expect(await readFile(credential, "utf8")).toBe(before); expect((await readJevConfig(agentDir))?.enabled).toBe(false);
    const keyringDir = join(base, "keyring"); let stores = 0;
    await saveJevSetup({ agentDir: keyringDir, enabled: true, source: "keyring", key: "stored", storeKeyring: async () => { stores++; } });
    await saveJevSetup({ agentDir: keyringDir, snapshot: await readJevSetupSnapshot(keyringDir), enabled: false, source: "keyring", storeKeyring: async () => { stores++; } });
    expect(stores).toBe(1);
  });

  it("supports allowlisted environment references without copying the secret", async () => {
    const base = await root(), agentDir = join(base, "agent");
    await saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "TYPESAFE_API_KEY" });
    expect(await resolveJevKey((await readJevConfig(agentDir))!, { TYPESAFE_API_KEY: "env-secret" })).toBe("env-secret");
    await expect(saveJevSetup({ agentDir: join(base, "bad"), enabled: true, source: "environment", reference: "OTHER" })).rejects.toThrow("Invalid");
    await expect(saveJevSetup({ agentDir: join(base, "relative"), enabled: true, source: "file", reference: "relative.json", key: "key" })).rejects.toThrow("Invalid");
  });

  it("redacts keyring failures and never falls back", async () => {
    const base = await root(), agentDir = join(base, "agent"); await mkdir(agentDir);
    const failure = saveJevSetup({ agentDir, enabled: true, source: "keyring", key: "secret", storeKeyring: async () => { throw new Error("raw sentinel secret"); } });
    await expect(failure).rejects.not.toThrow(/raw sentinel/); expect(await readJevConfig(agentDir)).toBeUndefined();
    expect(jevStorageErrorMessage(await failure.catch((error) => error))).toContain("libsecret-tools");
    expect(jevStorageErrorMessage(new Error("raw sentinel"))).not.toContain("sentinel");
  });

  it("rejects stale snapshots and concurrent changes", async () => {
    const base = await root(), agentDir = join(base, "agent");
    await saveJevSetup({ agentDir, enabled: false, source: "environment", reference: "JEV_API_KEY" });
    const stale = await readJevSetupSnapshot(agentDir); await saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "JEV_API_KEY" });
    await expect(saveJevSetup({ agentDir, snapshot: stale, enabled: false, source: "environment", reference: "JEV_API_KEY" })).rejects.toThrow("changed");
    const snapshot = await readJevSetupSnapshot(agentDir);
    await expect(saveJevSetup({ agentDir, snapshot, enabled: false, source: "environment", reference: "JEV_API_KEY", beforeCommit: async () => { const current = await readFile(join(agentDir, "subagents-jev.json"), "utf8"); await writeFile(join(agentDir, "subagents-jev.json"), current.replace("true", "false")); } })).rejects.toThrow("changed");
  });

  it("rejects intermediate/final symlinks and repository destinations including .git files", async () => {
    const base = await root(), outside = join(base, "outside"); await mkdir(outside);
    const link = join(base, "link"); await symlink(outside, link); await expect(ensureSafePath(join(link, "key.json"), true, true)).rejects.toThrow("Unsafe");
    const target = join(base, "target"); await writeFile(target, "x"); const final = join(base, "final"); await symlink(target, final); await expect(ensureSafePath(final)).rejects.toThrow("Unsafe");
    const repo = join(base, "repo"), checkout = join(base, "checkout"); await mkdir(repo); await mkdir(checkout); await writeFile(join(repo, ".git"), "gitdir: elsewhere\n"); await mkdir(join(checkout, ".git"));
    await expect(saveJevSetup({ agentDir: join(base, "agent-a"), enabled: true, source: "file", reference: join(repo, "sub", "key.json"), key: "key" })).rejects.toThrow("Unsafe");
    await expect(saveJevSetup({ agentDir: join(base, "agent-b"), enabled: true, source: "file", reference: join(checkout, "sub", "key.json"), key: "key" })).rejects.toThrow("Unsafe");
  });

  it("preserves an unrelated credential file rather than replacing it", async () => {
    const base = await root(), agentDir = join(base, "agent"), credential = join(base, "existing.json"); await writeFile(credential, "unrelated\n"); if (process.platform !== "win32") await chmod(credential, 0o600);
    await expect(saveJevSetup({ agentDir, enabled: true, source: "file", reference: credential, key: "new" })).rejects.toThrow(); expect(await readFile(credential, "utf8")).toBe("unrelated\n");
  });

  it("runs an explicit bounded connection request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => { expect(init?.headers).toMatchObject({ Authorization: "Bearer key" }); expect(init?.redirect).toBe("error"); return new Response(JSON.stringify({ model: "jev-latest", answers: { route: { type: "choice", choice: "ok", confidence: 0.01, probabilities: { ok: 1 } } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }); });
    await testJevConnection("key", fetcher); expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
