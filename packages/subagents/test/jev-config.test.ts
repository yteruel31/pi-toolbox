import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultJevCredentialPath, readJevConfig, resolveJevKey, saveJevSetup, testJevConnection } from "../src/agents/jev-config.js";

const cleanup: string[] = [];
afterEach(async () => Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))));
async function root() { const value = await mkdtemp(join(tmpdir(), "pi-subagents-jev-")); cleanup.push(value); return value; }

describe("Jev setup storage", () => {
  it("writes private config and credential files only when saved", async () => {
    const base = await root();
    const agentDir = join(base, "agent");
    const credential = defaultJevCredentialPath(agentDir);
    await saveJevSetup({ agentDir, enabled: true, source: "file", reference: credential, key: "secret-value" });
    expect(await readJevConfig(agentDir)).toEqual({ version: 1, enabled: true, credential: { source: "file", value: credential } });
    expect(await resolveJevKey((await readJevConfig(agentDir))!)).toBe("secret-value");
    if (process.platform !== "win32") expect((await stat(credential)).mode & 0o777).toBe(0o600);
    expect(await readFile(join(agentDir, "subagents-jev.json"), "utf8")).not.toContain("secret-value");
  });

  it("supports environment references without copying the secret", async () => {
    const base = await root();
    const agentDir = join(base, "agent");
    await saveJevSetup({ agentDir, enabled: true, source: "environment", reference: "JEV_API_KEY" });
    expect(await resolveJevKey((await readJevConfig(agentDir))!, { JEV_API_KEY: "env-secret" })).toBe("env-secret");
  });

  it("keeps settings absent when keyring storage fails", async () => {
    const base = await root();
    const agentDir = join(base, "agent");
    await mkdir(agentDir);
    await expect(saveJevSetup({ agentDir, enabled: true, source: "keyring", key: "secret", storeKeyring: async () => { throw new Error("raw secret output"); } })).rejects.toThrow();
    expect(await readJevConfig(agentDir)).toBeUndefined();
  });

  it("runs an explicit bounded connection request", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: "Bearer key" });
      return new Response(JSON.stringify({ answers: { route: { choice: "ok" } } }), { status: 200 });
    });
    await testJevConnection("key", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
