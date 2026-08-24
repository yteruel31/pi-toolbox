import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileAgentDiscovery,
  MAX_AGENT_FILE_BYTES,
  MAX_AGENT_SKILL_NAME_CHARS,
  MAX_AGENT_SKILLS,
  MAX_AGENT_TOOL_NAME_CHARS,
  MAX_AGENT_TOOLS,
  MAX_MANIFEST_AGENT_DIRS,
  MAX_SCAN_DEPTH,
  MAX_WARNINGS,
  normalizePackageSettings,
} from "../src/agents/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-agents-"));
  roots.push(root);
  return root;
}

async function agentFile(
  filePath: string,
  name: string,
  description: string,
  body = `You are ${name}.`,
  extra = "",
): Promise<void> {
  await mkdir(join(filePath, ".."), { recursive: true });
  await writeFile(
    filePath,
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}\n`,
  );
}

async function packageRoot(
  root: string,
  directory: string,
  manifest: Record<string, unknown>,
): Promise<string> {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), JSON.stringify(manifest));
  return target;
}

describe("normalizePackageSettings", () => {
  it("normalizes strings and objects with deterministic later-scope precedence", () => {
    const result = normalizePackageSettings({
      user: ["npm:a", { source: "npm:b", autoload: false, extensions: [] }, "npm:a"],
      project: [{ source: "npm:b", autoload: true, skills: [] }, "npm:c"],
      projectTrusted: true,
    });

    expect(result.map(({ source, scope, autoload }) => ({ source, scope, autoload }))).toEqual([
      { source: "npm:a", scope: "user", autoload: undefined },
      { source: "npm:b", scope: "project", autoload: true },
      { source: "npm:c", scope: "project", autoload: undefined },
    ]);
  });

  it("ignores malformed entries and all untrusted project settings", () => {
    expect(normalizePackageSettings({
      user: ["", null, { source: "ok" }, { source: "bad", autoload: "no" }],
      project: ["project-only"],
      projectTrusted: false,
    }).map((entry) => entry.source)).toEqual(["ok"]);
  });
});

describe("FileAgentDiscovery", () => {
  it("recursively merges package, user, and trusted project definitions", async () => {
    const root = await workspace();
    const agentDir = join(root, "home", ".pi", "agent");
    const cwd = join(root, "project");
    const first = await packageRoot(root, "first", {
      name: "first-package",
      pi: { subagents: { agents: "agents" } },
    });
    const second = await packageRoot(root, "second", {
      name: "second-package",
      "pi-subagents": { agents: ["profiles"] },
    });
    await agentFile(join(first, "agents", "reviewer.md"), "reviewer", "first package");
    await agentFile(join(second, "profiles", "nested", "reviewer.md"), "reviewer", "second package");
    await agentFile(join(second, "profiles", "package-only.md"), "package-only", "package only");
    await agentFile(join(agentDir, "agents", "nested", "reviewer.md"), "reviewer", "user");
    await agentFile(join(agentDir, "agents", "user-only.md"), "user-only", "user only");
    await agentFile(
      join(cwd, ".pi", "agents", "reviewer.md"),
      "reviewer",
      "project",
      "Project prompt.",
      "harness: claude\nmodel: opus\nthinking: high\ntools: Read, Grep, Glob\nskills:\n  - code-review\n  - security:review\n",
    );

    const discovery = new FileAgentDiscovery({
      agentDir,
      packages: [
        { source: "npm:first", root: first },
        { source: "npm:second", root: second },
      ],
    });

    const untrusted = await discovery.discover({ cwd, projectTrusted: false });
    expect(untrusted.agents.find((agent) => agent.name === "reviewer")?.description).toBe("user");
    expect(untrusted.agents.map((agent) => agent.name)).toEqual([
      "package-only",
      "reviewer",
      "user-only",
    ]);

    const trusted = await discovery.discover({ cwd, projectTrusted: true });
    const reviewer = trusted.agents.find((agent) => agent.name === "reviewer");
    expect(reviewer).toMatchObject({
      description: "project",
      systemPrompt: "Project prompt.",
      tools: ["Read", "Grep", "Glob"],
      skills: ["code-review", "security:review"],
      defaults: { harness: "claude", model: "opus", thinking: "high" },
      source: { scope: "project" },
    });
    expect(trusted.warnings.some((warning) =>
      warning.includes("first-package") && warning.includes("second-package")
    )).toBe(true);
  });

  it("uses effective package settings, honors autoload false, and ignores resource filters", async () => {
    const root = await workspace();
    const agentDir = join(root, "agent-home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const disabled = await packageRoot(root, "disabled", {
      name: "disabled",
      pi: { subagents: { agents: ["agents"] } },
    });
    const enabled = await packageRoot(root, "enabled", {
      name: "enabled",
      pi: { subagents: { agents: ["agents"] } },
    });
    await agentFile(join(disabled, "agents", "disabled.md"), "disabled", "disabled");
    await agentFile(join(enabled, "agents", "enabled.md"), "enabled", "enabled");

    const discovery = new FileAgentDiscovery({
      agentDir,
      packages: [
        { source: "npm:disabled", root: disabled },
        { source: "npm:enabled", root: enabled },
      ],
      packageSettings: {
        user: [
          { source: "npm:disabled", autoload: false },
          { source: "npm:enabled", agents: [], extensions: [], skills: [] },
        ],
      },
    });

    const result = await discovery.discover({ cwd, projectTrusted: false });
    expect(result.agents.map((agent) => agent.name)).toEqual(["enabled"]);
  });

  it("rejects traversal, package-root symlinks, scan symlinks, excessive depth, and oversized files", async () => {
    const root = await workspace();
    const cwd = join(root, "project");
    const agentDir = join(root, "agent-home");
    const outside = join(root, "outside");
    await mkdir(outside, { recursive: true });
    await agentFile(join(outside, "escape.md"), "escape", "must not load");

    const pkg = await packageRoot(root, "pkg", {
      name: "unsafe-package",
      pi: { subagents: { agents: ["agents", "../outside"] } },
    });
    await agentFile(join(pkg, "agents", "valid.md"), "valid", "valid");
    await symlink(outside, join(pkg, "agents", "linked"));

    let deep = join(agentDir, "agents");
    for (let index = 0; index <= MAX_SCAN_DEPTH; index++) deep = join(deep, `d${index}`);
    await agentFile(join(deep, "too-deep.md"), "too-deep", "too deep");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    await writeFile(join(agentDir, "agents", "oversized.md"), "x".repeat(MAX_AGENT_FILE_BYTES + 1));

    const realSymlinkTarget = await packageRoot(root, "symlink-target", {
      name: "linked-package",
      pi: { subagents: { agents: "agents" } },
    });
    await agentFile(join(realSymlinkTarget, "agents", "linked-root.md"), "linked-root", "linked root");
    const linkedRoot = join(root, "linked-root");
    await symlink(realSymlinkTarget, linkedRoot);

    const discovery = new FileAgentDiscovery({
      agentDir,
      packages: [
        { source: "npm:unsafe", root: pkg },
        { source: "npm:linked", root: linkedRoot },
      ],
    });
    const result = await discovery.discover({ cwd, projectTrusted: false });

    expect(result.agents.map((agent) => agent.name)).toEqual(["valid"]);
    expect(result.warnings.join("\n")).toMatch(/escapes its package root/);
    expect(result.warnings.join("\n")).toMatch(/symlink/);
    expect(result.warnings.join("\n")).toMatch(/depth/);
    expect(result.warnings.join("\n")).toMatch(/oversized/);
  });

  it("caps manifest declarations and warning output without suppressing valid files", async () => {
    const root = await workspace();
    const cwd = join(root, "project");
    const declarations = Array.from({ length: MAX_MANIFEST_AGENT_DIRS + 1 }, (_, index) => `agents-${index}`);
    const pkg = await packageRoot(root, "pkg", {
      name: "many-dirs",
      pi: { subagents: { agents: declarations } },
    });
    await agentFile(join(pkg, declarations[0]!, "valid.md"), "valid", "valid");
    await agentFile(join(pkg, declarations.at(-1)!, "ignored.md"), "ignored", "ignored");
    for (let index = 0; index < MAX_WARNINGS + 10; index++) {
      await symlink(join(pkg, declarations[0]!, "valid.md"), join(pkg, declarations[0]!, `link-${index}.md`));
    }

    const result = await new FileAgentDiscovery({
      agentDir: join(root, "agent-home"),
      packages: [{ source: "npm:many", root: pkg }],
    }).discover({ cwd, projectTrusted: false });

    expect(result.agents.map((agent) => agent.name)).toEqual(["valid"]);
    expect(result.warnings.length).toBeLessThanOrEqual(MAX_WARNINGS + 1);
    expect(result.warnings.at(-1)).toMatch(/suppressed/);
  });

  it("accepts block and flow sequences for Claude-compatible skills frontmatter", async () => {
    const root = await workspace();
    const agentDir = join(root, "agent-home");
    const base = join(agentDir, "agents");
    await agentFile(
      join(base, "block.md"),
      "block",
      "block list",
      "body",
      "skills:\n- code-review # shared checklist\n- plugin:security\n",
    );
    await agentFile(
      join(base, "flow.md"),
      "flow",
      "flow list",
      "body",
      "skills: [\n  code-review,\n  'apps/web:deploy',\n]\n",
    );

    const result = await new FileAgentDiscovery({ agentDir }).discover({
      cwd: join(root, "project"),
      projectTrusted: false,
    });

    expect(result.warnings).toEqual([]);
    expect(result.agents.find((agent) => agent.name === "block")?.skills).toEqual([
      "code-review",
      "plugin:security",
    ]);
    expect(result.agents.find((agent) => agent.name === "flow")?.skills).toEqual([
      "code-review",
      "apps/web:deploy",
    ]);
  });

  it("accepts tool allowlists exactly at the count and name-length limits", async () => {
    const root = await workspace();
    const agentDir = join(root, "agent-home");
    const base = join(agentDir, "agents");
    const exactCount = Array.from(
      { length: MAX_AGENT_TOOLS },
      (_, index) => `tool-${index}`,
    );
    const exactLength = "t".repeat(MAX_AGENT_TOOL_NAME_CHARS);
    await agentFile(
      join(base, "exact-count.md"),
      "exact-count",
      "valid",
      "body",
      `tools: ${exactCount.join(", ")}\n`,
    );
    await agentFile(
      join(base, "exact-length.md"),
      "exact-length",
      "valid",
      "body",
      `tools: ${exactLength}\n`,
    );

    const result = await new FileAgentDiscovery({ agentDir }).discover({
      cwd: join(root, "project"),
      projectTrusted: false,
    });

    expect(result.warnings).toEqual([]);
    expect(result.agents.find((agent) => agent.name === "exact-count")?.tools).toEqual(exactCount);
    expect(result.agents.find((agent) => agent.name === "exact-length")?.tools).toEqual([exactLength]);
  });

  it("skips invalid files independently and bounds frontmatter metadata", async () => {
    const root = await workspace();
    const agentDir = join(root, "agent-home");
    const base = join(agentDir, "agents");
    await agentFile(join(base, "valid.md"), "valid", "valid");
    await writeFile(join(base, "missing.md"), "---\nname: missing\n---\nbody");
    await writeFile(
      join(base, "array-name.md"),
      "---\nname: [array-name]\ndescription: bad\n---\nbody",
    );
    await writeFile(
      join(base, "malformed-yaml.md"),
      "---\nname: malformed-yaml\ndescription: bad\nskills: [unterminated\n---\nbody",
    );
    await agentFile(join(base, "bad-name.md"), "../bad", "bad");
    await agentFile(join(base, "bad-harness.md"), "bad-harness", "bad", "body", "harness: other\n");
    await agentFile(join(base, "bad-thinking.md"), "bad-thinking", "bad", "body", "thinking: enormous\n");
    await agentFile(join(base, "empty-tools.md"), "empty-tools", "bad", "body", "tools:   \n");
    await agentFile(join(base, "empty-tool-name.md"), "empty-tool-name", "bad", "body", "tools: read,,bash\n");
    await agentFile(join(base, "bad-tool-name.md"), "bad-tool-name", "bad", "body", "tools: read, bad tool\n");
    await agentFile(join(base, "duplicate-tool.md"), "duplicate-tool", "bad", "body", "tools: read, read\n");
    await agentFile(join(base, "empty-skill.md"), "empty-skill", "bad", "body", "skills:\n  - \n");
    await agentFile(join(base, "bad-skill.md"), "bad-skill", "bad", "body", "skills: good, bad skill\n");
    await agentFile(
      join(base, "mapped-skill.md"),
      "mapped-skill",
      "bad",
      "body",
      "skills:\n  name: not-a-sequence\n",
    );
    await agentFile(join(base, "duplicate-skill.md"), "duplicate-skill", "bad", "body", "skills: good, good\n");
    await agentFile(
      join(base, "too-many-skills.md"),
      "too-many-skills",
      "bad",
      "body",
      `skills: ${Array.from({ length: MAX_AGENT_SKILLS + 1 }, (_, index) => `skill-${index}`).join(", ")}\n`,
    );
    await agentFile(
      join(base, "long-skill-name.md"),
      "long-skill-name",
      "bad",
      "body",
      `skills: ${"s".repeat(MAX_AGENT_SKILL_NAME_CHARS + 1)}\n`,
    );
    await agentFile(
      join(base, "too-many-tools.md"),
      "too-many-tools",
      "bad",
      "body",
      `tools: ${Array.from({ length: MAX_AGENT_TOOLS + 1 }, (_, index) => `tool-${index}`).join(", ")}\n`,
    );
    await agentFile(
      join(base, "long-tool-name.md"),
      "long-tool-name",
      "bad",
      "body",
      `tools: ${"t".repeat(MAX_AGENT_TOOL_NAME_CHARS + 1)}\n`,
    );

    const result = await new FileAgentDiscovery({ agentDir }).discover({
      cwd: join(root, "project"),
      projectTrusted: false,
    });
    expect(result.agents.map((agent) => agent.name)).toEqual(["valid"]);
    expect(result.warnings.length).toBeGreaterThanOrEqual(4);
  });
});
