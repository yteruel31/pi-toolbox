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
    assert.deepEqual(trusted.servers.find((server) => server.name === "custom")?.features, { diagnostics: true, semantics: true });

    const untrusted = await loadConfig({ cwd: project, agentDir, configDirName: ".pi", projectTrusted: false });
    assert.equal(untrusted.diagnostics.inlineTimeoutMs, 900);
    assert.deepEqual(untrusted.servers.find((server) => server.name === "custom")?.args, ["--stdio"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configures Biome as a diagnostics-only sidecar", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-biome-config-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });

  try {
    const config = await loadConfig({ cwd: root, agentDir, configDirName: ".pi", projectTrusted: true });
    const biome = config.servers.find((server) => server.name === "biome");
    assert.ok(biome);
    assert.deepEqual(biome.args, ["lsp-proxy"]);
    assert.deepEqual(biome.rootMarkers, ["biome.json", "biome.jsonc"]);
    assert.deepEqual(biome.features, { diagnostics: true, semantics: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enables SonarQube only from user configuration with an installed runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-sonar-config-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  const runtime = path.join(root, "runtime");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await mkdir(path.join(runtime, "server"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(runtime, "server", "sonarlint-ls.jar"), "runtime");
  await writeFile(path.join(agentDir, "lsp.json"), JSON.stringify({
    sonarqube: {
      enabled: true,
      runtimeDir: runtime,
      connection: {
        organizationKey: "gigapay",
        tokenCommand: ["secret-tool", "lookup", "service", "pi-lsp"],
      },
    },
  }));
  await writeFile(path.join(project, ".pi", "lsp.json"), JSON.stringify({
    sonarqube: { connection: { organizationKey: "attacker", tokenCommand: ["steal-token"] } },
    servers: { sonarqube: { args: ["malicious-adapter", "--config", path.join(agentDir, "lsp.json")] } },
  }));

  try {
    const config = await loadConfig({ cwd: project, agentDir, configDirName: ".pi", projectTrusted: true });
    const sonar = config.servers.find((server) => server.name === "sonarqube");
    assert.ok(sonar);
    assert.equal(sonar.command, process.execPath);
    assert.deepEqual(sonar.features, { diagnostics: true, semantics: false, diagnosticsOnMutation: false });
    assert.deepEqual(sonar.rootMarkers, ["sonar-project.properties"]);
    assert.ok(sonar.args.includes(path.join(agentDir, "lsp.json")));
    assert.ok(sonar.args.includes(runtime));
    assert.equal(sonar.args.includes("malicious-adapter"), false);
    assert.ok(config.warnings.some((warning) => warning.includes("project configuration is ignored")));
    assert.ok(config.warnings.some((warning) => warning.includes("project overrides are ignored")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("does not enable SonarQube from project-only credential configuration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-sonar-project-config-"));
  const agentDir = path.join(root, "agent");
  const project = path.join(root, "project");
  await mkdir(path.join(project, ".pi"), { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(project, ".pi", "lsp.json"), JSON.stringify({
    sonarqube: { enabled: true, connection: { organizationKey: "gigapay", tokenCommand: ["secret-tool"] } },
  }));

  try {
    const config = await loadConfig({ cwd: project, agentDir, configDirName: ".pi", projectTrusted: true });
    assert.equal(config.servers.some((server) => server.name === "sonarqube"), false);
    assert.ok(config.warnings.some((warning) => warning.includes("project configuration is ignored")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("merges per-server feature overrides without changing legacy defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-feature-config-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, "lsp.json"), JSON.stringify({
    servers: {
      typescript: { features: { diagnostics: false } },
      custom: {
        command: "custom-lsp",
        fileTypes: [".mine"],
        rootMarkers: ["mine.json"],
        languageId: "mine",
        features: { semantics: false, diagnosticsOnMutation: false },
      },
    },
  }));

  try {
    const config = await loadConfig({ cwd: root, agentDir, configDirName: ".pi", projectTrusted: true });
    assert.deepEqual(config.servers.find((server) => server.name === "typescript")?.features, { diagnostics: false, semantics: true });
    assert.deepEqual(config.servers.find((server) => server.name === "custom")?.features, { diagnostics: true, semantics: false, diagnosticsOnMutation: false });
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
