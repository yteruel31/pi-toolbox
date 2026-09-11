import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig, resolveKey } from "../src/config.js";
import { ResearchManager } from "../src/research.js";

async function helper(script: string, run: (env: NodeJS.ProcessEnv) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "web-keyring-test-"));
  try {
    await writeFile(join(directory, "secret-tool"), `#!/bin/sh\n${script}\n`, { mode: 0o700 });
    await run({ PATH: directory, OPENAI_API_KEY: "must-not-fallback", GEMINI_API_KEY: "must-not-fallback" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const config = parseConfig({ credentials: { openai: "keyring:pi-web-access/openai", gemini: "keyring:pi-web-access/gemini", brave: "keyring:pi-web-access/brave" } }, "/tmp");
test("keyring lookup uses fixed attributes, no shell interpolation, and refreshes on each read", { skip: process.platform !== "linux" }, async () => {
  await helper('test "$#" = 5 && test "$1" = lookup && test "$2" = application && test "$3" = pi-web-access && test "$4" = provider || exit 1\nprintf "fixture-%s\\n" "$5"', async (env) => {
    for (const provider of ["openai", "gemini", "brave"] as const) assert.equal(await resolveKey(config, provider, env), `fixture-${provider}`);
    await writeFile(join(env.PATH!, "secret-tool"), '#!/bin/sh\nprintf "rotated-fixture"\n', { mode: 0o700 });
    assert.equal(await resolveKey(config, "openai", env), "rotated-fixture");
  });
});
test("keyring failures never expose helper output or fall back to environment keys", { skip: process.platform !== "linux" }, async () => {
  for (const script of ['printf "sensitive-output"; printf "sensitive-diagnostic" >&2; exit 1', 'exit 0', 'printf "bad key"', 'printf "\\177"', 'i=0; while [ "$i" -lt 20000 ]; do printf x; i=$((i+1)); done']) {
    await helper(script, async (env) => {
      await assert.rejects(resolveKey(config, "openai", env), (error: Error) => {
        assert.match(error.message, /Linux keyring/);
        assert.doesNotMatch(error.message, /sensitive|must-not-fallback|bad key|xxxxxxxx/);
        assert.equal(error.cause, undefined);
        return true;
      });
    });
  }
});
test("missing helper and cancelled lookup produce sanitized failures", { skip: process.platform !== "linux" }, async () => {
  await helper('exec /bin/sleep 30', async (env) => {
    await assert.rejects(resolveKey(config, "openai", env, AbortSignal.timeout(50)), /Linux keyring lookup failed/);
    await rm(join(env.PATH!, "secret-tool"));
    await assert.rejects(resolveKey(config, "openai", env), /Linux keyring lookup failed/);
  });
});
test("malformed or mismatched references cannot become literals or helper arguments", async () => {
  for (const source of ["keyring:other/openai", "keyring:pi-web-access/gemini", "keyring:pi-web-access/openai;echo", "keyring:"]) {
    const invalid = parseConfig({ credentials: { openai: source } }, "/tmp");
    await assert.rejects(resolveKey(invalid, "openai", {}), /Invalid keyring reference/);
  }
});
test("async credential failure creates no research record or provider submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-keyring-research-"));
  let submissions = 0;
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), {
    key: async () => { throw new Error("Linux keyring lookup failed"); },
    start: async () => { submissions++; throw new Error("Unexpected submission"); },
  });
  try {
    await assert.rejects(manager.start({ provider: "openai", subject: "Test" }, directory), /Linux keyring/);
    assert.deepEqual(await manager.list(), []); assert.equal(submissions, 0);
  } finally { await manager.stop(); await rm(directory, { recursive: true, force: true }); }
});
test("research awaits credentials for submission, polling and cancellation without persisting them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "web-keyring-lifecycle-"));
  let lookups = 0;
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), {
    key: async () => `private-fixture-${++lookups}`,
    start: async (_provider, _subject, options) => { assert.equal(options.apiKey, "private-fixture-1"); return { upstreamId: "mock_123", status: "queued", report: "", citations: [] }; },
    get: async (_provider, _id, options) => { assert.equal(options.apiKey, "private-fixture-2"); return { upstreamId: "mock_123", status: "in_progress", report: "", citations: [] }; },
    cancel: async (_provider, _id, options) => { assert.equal(options.apiKey, "private-fixture-3"); return { upstreamId: "mock_123", status: "cancelled", report: "", citations: [] }; },
  });
  try {
    const job = await manager.start({ provider: "openai", subject: "Test" }, directory); await manager.idle();
    assert.equal((await manager.read(job.researchId)).status, "queued");
    assert.equal((await manager.refresh(job.researchId)).status, "in_progress");
    assert.equal((await manager.cancel(job.researchId)).status, "cancelled");
    assert.equal(lookups, 3); assert.doesNotMatch(JSON.stringify(await manager.list()), /private-fixture/);
  } finally { await manager.stop(); await rm(directory, { recursive: true, force: true }); }
});
