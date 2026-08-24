import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  MAX_AGENT_SKILLS,
  MAX_PRELOADED_SKILL_FILE_BYTES,
  MAX_PRELOADED_SKILLS_TOTAL_BYTES,
  appendPreloadedSkills,
  formatPreloadedSkill,
  preloadAgentSkills,
} from "../src/agents/index.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })
  ));
});

function skill(
  name: string,
  options: { disabled?: boolean; filePath?: string; baseDir?: string } = {},
): Skill {
  const filePath = options.filePath ?? `/skills/${name}/SKILL.md`;
  return {
    name,
    description: `${name} instructions`,
    filePath,
    baseDir: options.baseDir ?? `/skills/${name}`,
    disableModelInvocation: options.disabled ?? false,
    sourceInfo: {} as Skill["sourceInfo"],
  };
}

const input = {
  names: ["review", "manual", "missing"],
  cwd: "/project",
  projectTrusted: true,
  agentDir: "/agent",
};

describe("preloadAgentSkills", () => {
  it("does not discover or read anything for an empty declaration", async () => {
    let called = false;
    const result = await preloadAgentSkills(
      { ...input, names: [] },
      {
        loadSkills: async () => {
          called = true;
          return [];
        },
      },
    );

    expect(called).toBe(false);
    expect(result).toEqual({ content: "", loaded: [], warnings: [] });
  });

  it("rejects unbounded or duplicate direct API declarations before discovery", async () => {
    let called = false;
    const loadSkills = async () => {
      called = true;
      return [];
    };
    const tooMany = await preloadAgentSkills(
      {
        ...input,
        names: Array.from({ length: MAX_AGENT_SKILLS + 1 }, (_, index) => `s-${index}`),
      },
      { loadSkills },
    );
    const duplicate = await preloadAgentSkills(
      { ...input, names: ["review", "review"] },
      { loadSkills },
    );

    expect(called).toBe(false);
    expect(tooMany.warnings).toEqual(["Skill preload exceeds the name count limit."]);
    expect(duplicate.warnings).toEqual(["Skill preload contains a duplicate name."]);
  });

  it("resolves enabled Pi skills with the official resource loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-skills-"));
    temporary.push(root);
    const cwd = join(root, "project");
    const agentDir = join(root, "agent-home");
    const skillDir = join(agentDir, "skills", "review");
    const manualDir = join(agentDir, "skills", "manual");
    const oversizedDir = join(agentDir, "skills", "oversized-real");
    const projectSkillDir = join(cwd, ".pi", "skills", "project-review");
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(skillDir, { recursive: true }),
      mkdir(manualDir, { recursive: true }),
      mkdir(oversizedDir, { recursive: true }),
      mkdir(projectSkillDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(skillDir, "SKILL.md"),
        "---\nname: review\ndescription: Review code.\n---\n\n# Review\n",
      ),
      writeFile(
        join(manualDir, "SKILL.md"),
        "---\nname: manual\ndescription: Manual only.\ndisable-model-invocation: true\n---\n\n# Manual\n",
      ),
      writeFile(
        join(projectSkillDir, "SKILL.md"),
        "---\nname: project-review\ndescription: Project review.\n---\n\n# Project review\n",
      ),
    ]);

    const result = await preloadAgentSkills({
      names: ["review", "manual", "project-review"],
      cwd,
      projectTrusted: false,
      agentDir,
    });

    expect(result.loaded).toEqual(["review"]);
    expect(result.warnings).toEqual([
      'Skill "manual" disables model invocation and was not preloaded.',
      'Skill "project-review" was not found and was not preloaded.',
    ]);
    expect(result.content).toContain("# Review");

    const trusted = await preloadAgentSkills({
      names: ["project-review"],
      cwd,
      projectTrusted: true,
      agentDir,
    });
    expect(trusted.loaded).toEqual(["project-review"]);
    expect(trusted.content).toContain("# Project review");

    await writeFile(
      join(oversizedDir, "SKILL.md"),
      `---\nname: oversized-real\ndescription: Oversized.\n---\n${"x".repeat(MAX_PRELOADED_SKILL_FILE_BYTES)}`,
    );
    const oversized = await preloadAgentSkills({
      names: ["oversized-real"],
      cwd,
      projectTrusted: false,
      agentDir,
    });
    expect(oversized.warnings).toEqual([
      'Skill "oversized-real" exceeds the preload size limit and was not preloaded.',
    ]);
  });

  it("injects visible skill bodies in declaration order and skips unavailable skills", async () => {
    const review = skill("review");
    const manual = skill("manual", { disabled: true });
    const files = new Map([
      [
        review.filePath,
        "---\nname: review\ndescription: Review code.\n---\n\n# Review\n\nUse the checklist.\n",
      ],
    ]);

    const result = await preloadAgentSkills(input, {
      loadSkills: async () => [manual, review],
      readFile: async (filePath) => files.get(filePath) ?? "",
    });

    expect(result.loaded).toEqual(["review"]);
    expect(result.warnings).toEqual([
      'Skill "manual" disables model invocation and was not preloaded.',
      'Skill "missing" was not found and was not preloaded.',
    ]);
    expect(result.content).toContain(
      '<skill name="review" location="/skills/review/SKILL.md">',
    );
    expect(result.content).toContain("References are relative to /skills/review.");
    expect(result.content).toContain("# Review\n\nUse the checklist.");
    expect(result.content).not.toContain("description: Review code");
  });

  it("skips unreadable and oversized skills without failing the preload", async () => {
    const unreadable = skill("unreadable");
    const oversized = skill("oversized");

    const result = await preloadAgentSkills(
      { ...input, names: ["unreadable", "oversized"] },
      {
        loadSkills: async () => [unreadable, oversized],
        readFile: async (filePath) => {
          if (filePath === oversized.filePath) {
            return "x".repeat(MAX_PRELOADED_SKILL_FILE_BYTES + 1);
          }
          throw new Error("denied");
        },
      },
    );

    expect(result.content).toBe("");
    expect(result.loaded).toEqual([]);
    expect(result.warnings.join("\n")).toMatch(/could not be read/);
    expect(result.warnings.join("\n")).toMatch(/preload size limit/);
  });

  it("skips a whole skill when the formatted aggregate would exceed its limit", async () => {
    const names = ["first", "second", "third"];
    const available = names.map((name) => skill(name));
    const body = "x".repeat(Math.floor(MAX_PRELOADED_SKILLS_TOTAL_BYTES / 3));

    const result = await preloadAgentSkills(
      { ...input, names },
      {
        loadSkills: async () => available,
        readFile: async () => body,
      },
    );

    expect(result.loaded).toEqual(["first", "second"]);
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(
      MAX_PRELOADED_SKILLS_TOTAL_BYTES,
    );
    expect(result.warnings).toEqual([
      'Skill "third" exceeds the aggregate preload size limit and was skipped.',
    ]);
  });

  it("turns catalog failures into one non-blocking warning", async () => {
    const result = await preloadAgentSkills(input, {
      loadSkills: async () => {
        throw new Error("catalog failed");
      },
    });

    expect(result).toEqual({
      content: "",
      loaded: [],
      warnings: ["Skills could not be discovered; no skills were preloaded."],
    });
  });
});

describe("skill prompt formatting", () => {
  it("escapes XML attributes while retaining the reference base", () => {
    const formatted = formatPreloadedSkill(
      skill('review"&', {
        filePath: '/skills/"review&/SKILL.md',
        baseDir: '/skills/"review&',
      }),
      "instructions",
    );
    expect(formatted).toContain('name="review&quot;&amp;"');
    expect(formatted).toContain('location="/skills/&quot;review&amp;/SKILL.md"');
    expect(formatted).toContain('References are relative to /skills/"review&amp;.');
  });

  it("places skill blocks after the named-agent prompt", () => {
    expect(appendPreloadedSkills("Review strictly.\n", "<skill>body</skill>\n")).toBe(
      "Review strictly.\n\n<skill>body</skill>",
    );
    expect(appendPreloadedSkills("", "")).toBeUndefined();
  });
});
