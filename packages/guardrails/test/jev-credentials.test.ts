import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveJevCredential, saveJevCredential } from "../src/jev-credentials.js";
import { config } from "./helpers.js";

const withCredential = (source: "environment" | "keyring" | "file", reference: string) => config({ backend: "jev", jev: { model: "jev-latest", allowThreshold: .95, denyThreshold: .8, credential: { source, reference } } });

test("environment credentials never write and keyring uses only the injected Secret Service adapter", async () => {
  assert.equal(await resolveJevCredential(withCredential("environment", "SAFE_KEY"), undefined, { SAFE_KEY: "abc123" }), "abc123");
  await assert.rejects(saveJevCredential("environment", "SAFE_KEY", "abc123"));
  const calls: unknown[][] = [];
  const adapter = async (args: string[], stdin?: string) => { calls.push([args, stdin]); return stdin ?? "from-keyring"; };
  assert.equal(await resolveJevCredential(withCredential("keyring", "pi-guardrails/jev"), undefined, {}, adapter), "from-keyring");
  await saveJevCredential("keyring", "pi-guardrails/jev", "stored-key", adapter);
  assert.equal(calls.length, 2); assert.match((calls[1][0] as string[]).join(" "), /store/); assert.equal(calls[1][1], "stored-key");
  await assert.rejects(resolveJevCredential(withCredential("keyring", "pi-guardrails/jev"), undefined, {}, async () => { throw Error("unavailable"); }));
});

test("private credential files round-trip but repositories, symlinks, unsafe modes and unknown schemas are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "jev-credentials-"));
  try {
    const privateDir = join(root, "private"); await mkdir(privateDir, { mode: 0o700 }); const file = join(privateDir, "jev.json");
    await saveJevCredential("file", file, "first-key"); assert.equal(await resolveJevCredential(withCredential("file", file)), "first-key"); assert.equal((await lstat(file)).mode & 0o777, 0o600);
    await writeFile(file, JSON.stringify({ other: "value" }), { mode: 0o600 }); await assert.rejects(saveJevCredential("file", file, "replacement"));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { other: "value" });
    await writeFile(file, JSON.stringify({ jev: "old" }), { mode: 0o600 }); await chmod(file, 0o644); await assert.rejects(resolveJevCredential(withCredential("file", file)));
    const target = join(privateDir, "target"); await writeFile(target, JSON.stringify({ jev: "old" }), { mode: 0o600 }); const alias = join(privateDir, "alias"); await symlink(target, alias); await assert.rejects(resolveJevCredential(withCredential("file", alias)));
    const repo = join(root, "repo"); await mkdir(join(repo, ".git"), { recursive: true }); await chmod(repo, 0o700); await assert.rejects(saveJevCredential("file", join(repo, "key.json"), "key"));
  } finally { await rm(root, { recursive: true }); }
});
