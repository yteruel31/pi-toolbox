import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig } from "../src/config.js";
import { findProjectRoot, resolveExecutable } from "../src/paths.js";

test("loads user config before trusted project overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-config-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "lsp.json"), JSON.stringify({
    diagnostics: { inlineTimeoutMs: 900 },
    servers: {
      pyright: false,
      custom: { command: "custom-lsp", args: ["--stdio"], fileTypes: [".mine"], rootMarkers: ["mine.json"], languageId: "mine" },
    },
  }));
  await writeFile(path.join(project, ".pi", "lsp.json"), JSON.stringify({
    diagnostics: { inlineTimeoutMs: 1_200 },
    servers: { custom: { args: ["serve"] } },
  }));

  try {
    const trusted = await loadConfig({ cwd: project, agentDir, configDirName: ".pi", projectTrusted: true });
    assert.equal(trusted.diagnostics.inlineTimeoutMs, 1_200);
    assert.equal(trusted.servers.some((server) => server.name === "pyright"), false);
    assert.deepEqual(trusted.servers.find((server) => server.name === "custom")?.args, ["serve"]);

    const untrusted = await loadConfig({ cwd: project, agentDir, configDirName: ".pi", projectTrusted: false });
    assert.equal(untrusted.diagnostics.inlineTimeoutMs, 900);
    assert.deepEqual(untrusted.servers.find((server) => server.name === "custom")?.args, ["--stdio"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("finds the nearest root marker and project-local executable", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-paths-"));
  const nested = path.join(root, "packages", "app", "src");
  const binary = path.join(root, "node_modules", ".bin", "fake-lsp");
  await mkdir(nested, { recursive: true });
  await mkdir(path.dirname(binary), { recursive: true });
  await writeFile(path.join(root, "packages", "app", "package.json"), "{}");
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
  const file = path.join(nested, "index.ts");
  await writeFile(file, "export {}\n");

  try {
    const projectRoot = await findProjectRoot(file, root, ["package.json"]);
    assert.equal(projectRoot, path.join(root, "packages", "app"));
    assert.equal(await resolveExecutable("fake-lsp", projectRoot!, root), binary);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
