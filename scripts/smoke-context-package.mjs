import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(root, "packages/context");
const expectedTools = ["memory_search", "memory_remember", "memory_forget", "memory_lessons", "memory_stats", "session_search", "session_list", "session_read", "knowledge_search", "kb_read", "recall"];
const expectedCommands = ["memory-consolidate", "session-sync", "session-reindex", "knowledge-search-setup", "knowledge-overview", "knowledge-refresh", "knowledge-reindex", "om:status", "om:view"];
const excludedCommands = ["session-embeddings-setup", "knowledge-add-kb"];
let temporary;
let tarball;

function assert(condition, message) {
  if (!condition) throw new Error(`Context package smoke failed: ${message}`);
}

try {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-context-package-"));
  await exec("npm", ["run", "build", "--workspace", "@yteruel31/pi-context"], { cwd: root });
  const packed = await exec("npm", ["pack", "--json", "--workspace", "@yteruel31/pi-context"], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
  const report = JSON.parse(packed.stdout);
  assert(Array.isArray(report) && report.length === 1, "npm pack did not return one JSON result");
  tarball = path.resolve(root, report[0].filename);
  const files = report[0].files.map((entry) => entry.path);
  for (const required of ["dist/index.js", "dist/index.d.ts", "src/index.ts", "skills/knowledge-capture/SKILL.md", "README.md", "CHANGELOG.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    assert(files.includes(required), `tarball is missing ${required}`);
  }
  for (const file of files) {
    assert(!/(^|\/)(test|tests|__tests__)(\/|$)/i.test(file), `tarball contains test path ${file}`);
    assert(!/(^|\/)(\.env(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key))$/i.test(file), `tarball contains possible secret ${file}`);
  }

  const project = path.join(temporary, "project");
  const agentDir = path.join(temporary, "agent");
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(path.join(project, "package.json"), JSON.stringify({ name: "context-smoke", private: true, type: "module" }));
  const hostPeers = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox"].map((name) => path.join(root, "node_modules", name));
  await exec("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", tarball, ...hostPeers], { cwd: project, maxBuffer: 10 * 1024 * 1024 });
  const installed = path.join(project, "node_modules/@yteruel31/pi-context");

  const packageManager = new DefaultPackageManager({ cwd: project, agentDir, settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }) });
  const resolved = await packageManager.resolveExtensionSources([installed], { local: true, temporary: true });
  const enabled = resolved.extensions.filter((resource) => resource.enabled);
  const enabledSkills = resolved.skills.filter((resource) => resource.enabled);
  assert(enabled.length === 1, `expected exactly one Pi extension, resolved ${enabled.length}`);
  assert(enabledSkills.length === 1, `expected exactly one Pi skill, resolved ${enabledSkills.length}`);
  assert(enabledSkills[0].path.endsWith("skills/knowledge-capture/SKILL.md"), `unexpected skill path: ${enabledSkills[0].path}`);

  const { loadExtensions } = await import(path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"));
  const loaded = await loadExtensions(enabled.map((resource) => resource.path), project);
  assert(loaded.errors.length === 0, `loader errors: ${JSON.stringify(loaded.errors)}`);
  assert(loaded.extensions.length === 1, `expected one loaded extension, got ${loaded.extensions.length}`);
  const extension = loaded.extensions[0];
  assert(JSON.stringify([...extension.tools.keys()]) === JSON.stringify(expectedTools), `unexpected tools: ${[...extension.tools.keys()].join(", ")}`);
  assert(JSON.stringify([...extension.commands.keys()]) === JSON.stringify(expectedCommands), `unexpected commands: ${[...extension.commands.keys()].join(", ")}`);
  for (const command of excludedCommands) assert(!extension.commands.has(command), `excluded command registered: ${command}`);
  await fs.access(path.join(agentDir, "context")).then(() => { throw new Error("factory load created context storage"); }, (error) => {
    if (error?.code !== "ENOENT") throw error;
  });

  const exported = await import(path.join(installed, "dist/index.js"));
  assert(typeof exported.default === "function", "built default export is not importable");
  console.log(`context tarball smoke passed: ${files.length} files, 1 extension, 1 skill, 11 tools, 9 commands`);
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  if (tarball) await fs.rm(tarball, { force: true });
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
}
