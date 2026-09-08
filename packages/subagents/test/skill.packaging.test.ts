import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  DefaultPackageManager,
  SettingsManager,
  formatSkillsForPrompt,
  loadSkills,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const toolboxRoot = path.resolve(packageRoot, "../..");
const skillPath = path.join(packageRoot, "skills/subagents/SKILL.md");

describe("subagents skill distribution", () => {
  it.each([packageRoot, toolboxRoot])("discovers the skill from the manifest at %s", async (root) => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-subagents-skill-"));
    try {
      const manager = new DefaultPackageManager({
        cwd: root,
        agentDir,
        settingsManager: SettingsManager.inMemory({}, { projectTrusted: true }),
      });
      const resources = await manager.resolveExtensionSources([root], { local: true, temporary: true });
      const loaded = loadSkills({
        cwd: root,
        agentDir,
        skillPaths: resources.skills.filter((resource) => resource.enabled).map((resource) => resource.path),
        includeDefaults: false,
      });
      expect(loaded.diagnostics).toEqual([]);
      const skills = loaded.skills.filter((skill) => skill.name === "subagents");
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({ filePath: skillPath, disableModelInvocation: false });
      expect(formatSkillsForPrompt(skills)).toContain("<name>subagents</name>");
      expect(formatSkillsForPrompt(skills)).toContain("configured routing");
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("includes the skill and its manifest in the npm file list", async () => {
    const { stdout } = await promisify(execFile)("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: packageRoot,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 30_000,
    });
    const [packed] = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    expect(packed?.files.map((file) => file.path)).toContain("skills/subagents/SKILL.md");
    const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    expect(manifest.pi.skills).toEqual(["./skills"]);
    expect(manifest.keywords).toContain("pi-package");
  });
});
