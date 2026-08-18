import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const root = path.resolve(import.meta.dirname, "..");
const { loadExtensions } = await import(
  path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")
);
const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const extensionPaths = manifest.pi.extensions.map((entry) => path.resolve(root, entry));
const result = await loadExtensions(extensionPaths, root);
if (result.errors.length > 0) {
  throw new Error(`Toolbox extension load failed: ${JSON.stringify(result.errors)}`);
}
const names = new Set(result.extensions.flatMap((extension) => [...extension.tools.keys()]));
for (const required of [
  "subagent_spawn",
  "subagent_agents",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
]) {
  if (!names.has(required)) throw new Error(`Missing clean-room subagent tool: ${required}`);
}
const temporaryAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-toolbox-packages-"));
try {
  const settingsManager = SettingsManager.inMemory({}, { projectTrusted: true });
  const packageManager = new DefaultPackageManager({
    cwd: root,
    agentDir: temporaryAgentDir,
    settingsManager,
  });
  for (const directory of (await fs.readdir(path.join(root, "packages"))).sort()) {
    const packageRoot = path.join(root, "packages", directory);
    const resolved = await packageManager.resolveExtensionSources([packageRoot], {
      local: true,
      temporary: true,
    });
    const enabled = resolved.extensions.filter((resource) => resource.enabled);
    if (enabled.length !== 1) {
      throw new Error(`${directory}: expected one independently resolvable extension, got ${enabled.length}`);
    }
  }
} finally {
  await fs.rm(temporaryAgentDir, { recursive: true, force: true });
}

console.log(`loaded ${result.extensions.length} toolbox extensions; all workspace manifests resolve independently`);
