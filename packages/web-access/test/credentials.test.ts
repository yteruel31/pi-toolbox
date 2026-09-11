import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseConfig, resolveKey } from "../src/config.js";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "web-credentials-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const reference = (directory: string) => parseConfig({ credentials: { openai: "file:pi-web-access/openai", gemini: "file:pi-web-access/gemini", brave: "file:pi-web-access/brave" } }, directory);

test("private file resolves each provider and rereads rotated credentials", async () => {
  await fixture(async (directory) => {
    const config = reference(directory);
    assert.equal(config.credentialsFile, join(directory, "web-access.credentials.json"));
    await writeFile(config.credentialsFile, JSON.stringify({ openai: "fixture-openai", gemini: "fixture-gemini", brave: "fixture-brave" }), { mode: 0o600 });
    for (const provider of ["openai", "gemini", "brave"] as const) assert.equal(await resolveKey(config, provider, {}), `fixture-${provider}`);
    await writeFile(config.credentialsFile, JSON.stringify({ openai: "rotated" }));
    assert.equal(await resolveKey(config, "openai", {}), "rotated");
    await assert.rejects(resolveKey(config, "brave", { BRAVE_API_KEY: "no-fallback" }), /missing or invalid/);
    await assert.rejects(resolveKey(config, "openai", {}, AbortSignal.abort()));
  });
});

test("missing, malformed and oversized files fail closed without disclosing values", async () => {
  await fixture(async (directory) => {
    const config = reference(directory);
    await assert.rejects(resolveKey(config, "openai", { OPENAI_API_KEY: "no-fallback" }), /Cannot open/);
    for (const content of ["SECRET", "null", "[]", '{"unexpected":"SECRET"}', '{"openai":42}', '{"openai":"SECRET with spaces"}', JSON.stringify({ openai: "SECRET".repeat(3000) }), "SECRET".repeat(12000)]) {
      await writeFile(config.credentialsFile, content, { mode: 0o600 });
      await assert.rejects(resolveKey(config, "openai", {}), (error: Error) => {
        assert.ok(!error.message.includes("SECRET"));
        return true;
      });
    }
  });
});

test("rejects unsafe permissions, directories and symlinks", { skip: process.platform === "win32" }, async () => {
  await fixture(async (directory) => {
    const config = reference(directory);
    await writeFile(config.credentialsFile, '{"openai":"fixture"}', { mode: 0o600 });
    for (const mode of [0o644, 0o660, 0o700]) {
      await chmod(config.credentialsFile, mode);
      await assert.rejects(resolveKey(config, "openai", {}), /mode 0600/);
    }
    await rm(config.credentialsFile);
    await mkdir(config.credentialsFile, { mode: 0o700 });
    await assert.rejects(resolveKey(config, "openai", {}), /regular file/);
    await rm(config.credentialsFile, { recursive: true });
    await symlink(directory, config.credentialsFile);
    await assert.rejects(resolveKey(config, "openai", {}), /Cannot open/);
    await rm(config.credentialsFile);
    await writeFile(join(directory, "target"), '{"openai":"fixture"}', { mode: 0o600 });
    await symlink(join(directory, "target"), config.credentialsFile);
    await assert.rejects(resolveKey(config, "openai", {}), /Cannot open/);
  });
});

test("file references must match the selected provider and cannot select arbitrary paths", async () => {
  for (const source of ["file:pi-web-access/gemini", "file:/tmp/secret", "file:pi-web-access/openai/extra"]) {
    await assert.rejects(resolveKey(parseConfig({ credentials: { openai: source } }, "/tmp"), "openai", {}), /Invalid file reference/);
  }
});

test("environment defaults and literal credentials are unchanged", async () => {
  assert.equal(await resolveKey(parseConfig({}, "/tmp"), "openai", { OPENAI_API_KEY: "environment" }), "environment");
  assert.equal(await resolveKey(parseConfig({ credentials: { openai: "literal" } }, "/tmp"), "openai", {}), "literal");
});
