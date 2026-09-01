import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadDiagramConfig, parseDiagramConfig } from "../src/config.js";

test("uses safe local defaults when no config exists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-config-"));
  try {
    const config = await loadDiagramConfig({ homeDir: home });
    assert.equal(config.hosting.mode, "local");
    assert.equal(config.hosting.listenAddress, "127.0.0.1");
    assert.equal(config.hosting.basePath, "/diagram");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("accepts tailscale and credential-free HTTPS custom hosting", () => {
  const tailscale = parseDiagramConfig({ hosting: { mode: "tailscale", basePath: "/diagram", port: 19878, httpsPort: 8443, hostname: "auto", requireTailscaleIdentity: true } });
  assert.equal(tailscale.hosting.requireTailscaleIdentity, true);
  const custom = parseDiagramConfig({ hosting: { mode: "custom", basePath: "/diagram", port: 19878, listenAddress: "127.0.0.1", externalUrl: "https://diagrams.example.com/diagram/" } });
  assert.equal(custom.hosting.externalUrl, "https://diagrams.example.com/diagram");
  const root = parseDiagramConfig({ hosting: { mode: "custom", basePath: "/", port: 19878, listenAddress: "127.0.0.1", externalUrl: "https://diagrams.example.com/" } });
  assert.equal(root.hosting.externalUrl, "https://diagrams.example.com");
});

test("rejects unsafe external URLs and non-loopback local listeners", () => {
  assert.throws(() => parseDiagramConfig({ hosting: { mode: "custom", basePath: "/diagram", port: 19878, listenAddress: "127.0.0.1", externalUrl: "http://example.com/diagram" } }), /HTTPS/);
  assert.throws(() => parseDiagramConfig({ hosting: { mode: "local", basePath: "/diagram", port: 19878, listenAddress: "0.0.0.0" } }), /loopback/);
  assert.throws(() => parseDiagramConfig({ hosting: { mode: "custom", basePath: "/diagram", port: 19878, listenAddress: "127.0.0.1", externalUrl: "https://user:pass@example.com/diagram" } }), /credential-free/);
});

test("reports malformed config rather than silently falling back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-config-bad-"));
  const configPath = path.join(root, "diagram.json");
  try {
    await writeFile(configPath, "{");
    await assert.rejects(() => loadDiagramConfig({ path: configPath }), /not valid JSON/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
