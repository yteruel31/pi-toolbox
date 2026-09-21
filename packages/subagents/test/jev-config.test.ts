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

  it("supports bounded environment references without copying or evaluating the secret", async () => {
    const base = await root(), agentDir = join(base, "agent");
    await saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "CUSTOM_JEV_TOKEN" });
    expect(await resolveJevKey((await readJevConfig(agentDir))!, { CUSTOM_JEV_TOKEN: "env-secret" })).toBe("env-secret");
    for (const reference of ["BAD NAME", "$JEV_API_KEY", "A".repeat(257)]) {
      await expect(saveJevSetup({ agentDir: join(base, `bad-${reference.length}`), enabled: true, source: "environment", reference })).rejects.toThrow("Invalid");
    }
    await expect(saveJevSetup({ agentDir: join(base, "relative"), enabled: true, source: "file", reference: "relative.json", key: "key" })).rejects.toThrow("Invalid");
  });

  it.runIf(process.platform !== "win32")("saves, loads, and updates environment settings under owned 0775 ancestors", async () => {
    const base = await root(), piDir = join(base, "pi"), agentDir = join(piDir, "agent");
    await mkdir(piDir, { mode: 0o775 }); await chmod(piDir, 0o775); await mkdir(agentDir, { mode: 0o700 }); await chmod(agentDir, 0o700);
    await saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "FIRST_JEV_KEY" });
    expect(await readJevConfig(agentDir)).toEqual({ version: 1, enabled: true, credential: { source: "environment", value: "FIRST_JEV_KEY" } });
    expect(await resolveJevKey((await readJevConfig(agentDir))!, { FIRST_JEV_KEY: "environment-secret" })).toBe("environment-secret");
    expect(await readFile(join(agentDir, "subagents-jev.json"), "utf8")).not.toContain("environment-secret");
    await saveJevSetup({ agentDir, snapshot: await readJevSetupSnapshot(agentDir), enabled: false, source: "environment", reference: "SECOND_JEV_KEY" });
    expect(await readJevConfig(agentDir)).toEqual({ version: 1, enabled: false, credential: { source: "environment", value: "SECOND_JEV_KEY" } });
    expect((await stat(piDir)).mode & 0o777).toBe(0o775); expect((await stat(agentDir)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform !== "win32")("keeps non-environment settings and credentials strict under owned 0775 ancestors", async () => {
    const base = await root(), writable = join(base, "writable"), agentDir = join(writable, "agent"), credential = join(writable, "key.json");
    await mkdir(writable); await chmod(writable, 0o775); await mkdir(agentDir, { mode: 0o700 });
    await writeFile(join(agentDir, "subagents-jev.json"), `${JSON.stringify({ version: 1, enabled: true, credential: { source: "file", value: credential } })}\n`, { mode: 0o600 });
    await writeFile(credential, '{"jev":"secret"}\n', { mode: 0o600 });
    await expect(readJevConfig(agentDir)).rejects.toThrow("Unsafe");
    await expect(resolveJevKey({ version: 1, enabled: true, credential: { source: "file", value: credential } })).rejects.toThrow("Unsafe");
    await expect(saveJevSetup({ agentDir, enabled: true, source: "file", reference: credential, key: "secret" })).rejects.toThrow("Unsafe");
    const storeKeyring = vi.fn(async () => undefined);
    await expect(saveJevSetup({ agentDir, enabled: true, source: "keyring", key: "secret", storeKeyring })).rejects.toThrow("Unsafe");
    expect(storeKeyring).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")("rejects settings below world-writable owned ancestors", async () => {
    const base = await root(), writable = join(base, "writable"), agentDir = join(writable, "agent"); await mkdir(writable); await chmod(writable, 0o777);
    await expect(saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "JEV_API_KEY" })).rejects.toThrow("Unsafe");
  });

  it("rejects unsafe settings file types and links", async () => {
    const base = await root(), agentDir = join(base, "agent"), config = join(agentDir, "subagents-jev.json"); await mkdir(agentDir);
    await symlink(join(base, "missing"), config); await expect(readJevConfig(agentDir)).rejects.toThrow("Unsafe"); await rm(config);
    await mkdir(config); await expect(readJevConfig(agentDir)).rejects.toThrow("Unsafe");
  });

  it.runIf(process.platform !== "win32")("rejects writable settings destinations and files while reading protected 0555 destinations", async () => {
    const base = await root(), agentDir = join(base, "agent"), config = join(agentDir, "subagents-jev.json"); await mkdir(agentDir, { mode: 0o700 });
    await chmod(agentDir, 0o770); await expect(saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "JEV_API_KEY" })).rejects.toThrow("Unsafe");
    await chmod(agentDir, 0o700); await writeFile(config, '{"version":1,"enabled":true,"credential":{"source":"environment","value":"JEV_API_KEY"}}\n', { mode: 0o600 }); await chmod(config, 0o660);
    await expect(readJevConfig(agentDir)).rejects.toThrow("Unsafe");
    await chmod(config, 0o600); await chmod(agentDir, 0o555); expect((await readJevConfig(agentDir))?.enabled).toBe(true); await chmod(agentDir, 0o700);
  });

  it.runIf(process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0)("rejects foreign-owned settings", async () => {
    const base = await root(), agentDir = join(base, "agent"), config = join(agentDir, "subagents-jev.json"); await mkdir(agentDir);
    await writeFile(config, '{"version":1,"enabled":false,"credential":{"source":"environment","value":"JEV_API_KEY"}}');
    const { chown } = await import("node:fs/promises"); await chown(config, 1, 1);
    await expect(readJevConfig(agentDir)).rejects.toThrow("Unsafe");
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
