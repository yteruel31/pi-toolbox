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
const askEntryPath = path.join(root, "packages/ask/src/index.ts");
const rootAskExtension = result.extensions.find((extension) => extension.path === askEntryPath);
if (!rootAskExtension) throw new Error("Toolbox root manifest did not load the Ask extension");
const rootAskTools = [...rootAskExtension.tools.keys()];
if (JSON.stringify(rootAskTools) !== JSON.stringify(["ask_user_question"])) {
  throw new Error(`Toolbox root Ask tools must be exactly ask_user_question, got: ${rootAskTools.join(", ") || "(none)"}`);
}
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
    if (directory === "ask") {
      const loaded = await loadExtensions(enabled.map((resource) => resource.path), packageRoot);
      if (loaded.errors.length > 0) {
        throw new Error(`ask: independent extension load failed: ${JSON.stringify(loaded.errors)}`);
      }
      const askTools = loaded.extensions.flatMap((extension) => [...extension.tools.keys()]);
      if (JSON.stringify(askTools) !== JSON.stringify(["ask_user_question"])) {
        throw new Error(`Independent Ask tools must be exactly ask_user_question, got: ${askTools.join(", ") || "(none)"}`);
      }
      const skills = resolved.skills.filter((resource) => resource.enabled);
      if (skills.length !== 1) throw new Error(`ask: expected one independently resolvable skill, got ${skills.length}`);
      const skill = await fs.readFile(skills[0].path, "utf8");
      if (!skill.includes("Use ask_user_question") || !skill.includes("Use `ask_user_question`")) {
        throw new Error("ask: advertised skill does not reference the loaded ask_user_question tool");
      }
    }
  }
} finally {
  await fs.rm(temporaryAgentDir, { recursive: true, force: true });
}

console.log(`loaded ${result.extensions.length} toolbox extensions; all workspace manifests resolve independently`);
