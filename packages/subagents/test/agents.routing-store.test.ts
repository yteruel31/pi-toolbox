import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileRoutingStore,
  MAX_ROUTING_FILE_BYTES,
} from "../src/agents/index.js";
import { nodeFileSystem } from "../src/agents/fs-seam.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-subagents-routing-"));
  roots.push(root);
  return root;
}

function store(root: string, projectTrusted = true): FileRoutingStore {
  return new FileRoutingStore({
    agentDir: join(root, "home", ".pi", "agent"),
    cwd: join(root, "project"),
    projectTrusted,
    now: () => 1234,
  });
}

describe("FileRoutingStore", () => {
  it("writes atomically with private modes and reads routes", async () => {
    const root = await workspace();
    const routingStore = store(root);

    await routingStore.write("user", {
      version: 1,
      agents: {
        reviewer: { harness: "claude", model: "opus", thinking: "high" },
      },
    });

    const filePath = routingStore.routingPath("user");
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
    expect((await readdir(join(filePath, ".."))).filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(await routingStore.read("user")).toEqual({
      routing: {
        version: 1,
        agents: {
          reviewer: { harness: "claude", model: "opus", thinking: "high" },
        },
      },
    });
  });

  it("preserves unknown root and entry fields while allowing known fields to be removed", async () => {
    const root = await workspace();
    const routingStore = store(root);
    const filePath = routingStore.routingPath("user");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, JSON.stringify({
      version: 1,
      future: { enabled: true },
      agents: {
        reviewer: {
          harness: "claude",
          model: "old",
          vendorOption: 42,
        },
        removed: { model: "haiku", keepOnlyIfAgentSurvives: true },
      },
    }));

    await routingStore.write("user", {
      version: 1,
      agents: {
        reviewer: { thinking: "low" },
      },
    });

    const raw = JSON.parse(await readFile(filePath, "utf8"));
    expect(raw).toEqual({
      version: 1,
      future: { enabled: true },
      agents: {
        reviewer: { vendorOption: 42, thinking: "low" },
      },
    });
  });

  it("refuses invalid data and oversized files", async () => {
    const root = await workspace();
    const routingStore = store(root);
    await expect(routingStore.write("user", {
      version: 1,
      agents: { reviewer: { harness: "invalid" as "pi" } },
    })).rejects.toThrow(/invalid harness/i);

    const filePath = routingStore.routingPath("user");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "x".repeat(MAX_ROUTING_FILE_BYTES + 1));
    expect((await routingStore.read("user")).invalidReason).toMatch(/size limit/);
  });

  it("requires explicit backup before resetting invalid JSON", async () => {
    const root = await workspace();
    const routingStore = store(root);
    const filePath = routingStore.routingPath("user");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "{ definitely invalid");

    await expect(routingStore.write("user", { version: 1, agents: {} })).rejects.toThrow(/back it up first/);
    expect(await readFile(filePath, "utf8")).toBe("{ definitely invalid");

    const backupPath = await routingStore.backupInvalid("user");
    expect(backupPath).toContain("subagents.json.invalid-1234");
    expect(await readFile(backupPath, "utf8")).toBe("{ definitely invalid");
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600);

    await routingStore.write("user", { version: 1, agents: {} });
    expect((await routingStore.read("user")).routing).toEqual({ version: 1, agents: {} });
  });

  it("allocates deterministic backup suffixes without overwriting an earlier backup", async () => {
    const root = await workspace();
    const routingStore = store(root);
    const filePath = routingStore.routingPath("user");
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "invalid");
    await writeFile(join(filePath, "..", "subagents.json.invalid-1234"), "earlier");

    const backup = await routingStore.backupInvalid("user");
    expect(backup).toMatch(/invalid-1234-1$/);
    expect(await readFile(join(filePath, "..", "subagents.json.invalid-1234"), "utf8")).toBe("earlier");
  });

  it("preserves the previous file and cleans the temporary file when atomic replacement fails", async () => {
    const root = await workspace();
    const baseStore = store(root);
    await baseStore.write("user", {
      version: 1,
      agents: { reviewer: { model: "old" } },
    });
    const filePath = baseStore.routingPath("user");
    const before = await readFile(filePath, "utf8");

    const failingStore = new FileRoutingStore({
      agentDir: join(root, "home", ".pi", "agent"),
      cwd: join(root, "project"),
      projectTrusted: true,
      now: () => 5678,
      fs: {
        ...nodeFileSystem,
        rename: async () => {
          throw Object.assign(new Error("injected"), { code: "EIO" });
        },
      },
    });

    await expect(failingStore.write("user", {
      version: 1,
      agents: { reviewer: { model: "new" } },
    })).rejects.toThrow("injected");
    expect(await readFile(filePath, "utf8")).toBe(before);
    expect((await readdir(join(filePath, ".."))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("ignores and blocks project routing for untrusted projects", async () => {
    const root = await workspace();
    const trusted = store(root, true);
    await trusted.write("project", {
      version: 1,
      agents: { reviewer: { model: "project" } },
    });

    const untrusted = store(root, false);
    expect(await untrusted.read("project")).toEqual({ routing: undefined });
    await expect(untrusted.write("project", { version: 1, agents: {} })).rejects.toThrow(/not trusted/);
    await expect(untrusted.backupInvalid("project")).rejects.toThrow(/not trusted/);
  });

  it("rejects symlinked routing files and project configuration directories", async () => {
    const root = await workspace();
    const routingStore = store(root);
    const userPath = routingStore.routingPath("user");
    const target = join(root, "target.json");
    await mkdir(join(userPath, ".."), { recursive: true });
    await writeFile(target, JSON.stringify({ version: 1, agents: {} }));
    await symlink(target, userPath);
    expect((await routingStore.read("user")).invalidReason).toMatch(/symlink/);

    const projectConfigTarget = join(root, "project-config-target");
    const projectDir = join(root, "project");
    await mkdir(projectConfigTarget, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await symlink(projectConfigTarget, join(projectDir, ".pi"));
    expect((await routingStore.read("project")).invalidReason).toMatch(/symlink/);
    await expect(routingStore.write("project", { version: 1, agents: {} })).rejects.toThrow(/back it up first/);
    await expect(routingStore.backupInvalid("project")).rejects.toThrow(/unsafe directory/);

    const realParent = join(root, "real-parent");
    await mkdir(join(realParent, "agent"), { recursive: true });
    await symlink(realParent, join(root, "parent-link"));
    const ancestorLinked = new FileRoutingStore({
      agentDir: join(root, "parent-link", "agent"),
      cwd: join(root, "other-project"),
      projectTrusted: true,
    });
    expect((await ancestorLinked.read("user")).invalidReason).toMatch(/cross a symlink/);
  });

  it("repairs existing routing directory and file permissions on write", async () => {
    const root = await workspace();
    const routingStore = store(root);
    const filePath = routingStore.routingPath("user");
    await mkdir(join(filePath, ".."), { recursive: true, mode: 0o777 });
    await writeFile(filePath, JSON.stringify({ version: 1, agents: {} }), { mode: 0o666 });
    await chmod(join(filePath, ".."), 0o777);
    await chmod(filePath, 0o666);

    await routingStore.write("user", { version: 1, agents: {} });
    expect((await lstat(join(filePath, ".."))).mode & 0o777).toBe(0o700);
    expect((await lstat(filePath)).mode & 0o777).toBe(0o600);
  });
});
