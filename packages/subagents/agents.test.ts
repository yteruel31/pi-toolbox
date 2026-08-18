import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  buildAgentCatalogPrompt,
  effectiveAgentRouting,
  loadAgentCatalog,
  parseAgentMarkdown,
  readAgentRoutingFile,
  repairAgentRoutingFile,
  resolveAgentSpawn,
  writeAgentRouting,
} from "./src/agents.ts";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-agents-"));
  const agentDir = path.join(root, "agent-home");
  const cwd = path.join(root, "project");
  fs.mkdirSync(path.join(agentDir, "agents"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    agentDir,
    cwd,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function writeAgent(
  filePath: string,
  options: { name: string; description?: string; prompt?: string },
) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    [
      "---",
      `name: ${options.name}`,
      ...(options.description ? [`description: ${options.description}`] : []),
      "---",
      "",
      options.prompt ?? `You are ${options.name}.`,
      "",
    ].join("\n"),
  );
}

test("agent markdown parsing extracts routing metadata and system prompt", () => {
  const parsed = parseAgentMarkdown(
    '---\r\nname: "reviewer"\r\ndescription: Review code\r\n---\r\n\r\nBe strict.\r\n',
  );
  assert.deepEqual(parsed, {
    name: "reviewer",
    description: "Review code",
    systemPrompt: "Be strict.",
  });
});

test("catalog discovers recursive user and trusted project agents with project precedence", () => {
  const env = fixture();
  try {
    writeAgent(path.join(env.agentDir, "agents", "nested", "reviewer.md"), {
      name: "reviewer",
      description: "User reviewer",
      prompt: "User prompt",
    });
    writeAgent(path.join(env.agentDir, "agents", "scout.md"), { name: "scout" });
    writeAgent(path.join(env.cwd, ".pi", "agents", "reviewer.md"), {
      name: "reviewer",
      description: "Project reviewer",
      prompt: "Project prompt",
    });

    const trusted = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(
      trusted.agents.map((agent) => [agent.name, agent.scope]),
      [
        ["reviewer", "project"],
        ["scout", "user"],
      ],
    );
    assert.equal(trusted.byName.get("reviewer")?.systemPrompt, "Project prompt");

    const untrusted = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: false,
    });
    assert.equal(untrusted.byName.get("reviewer")?.scope, "user");
    assert.equal(untrusted.projectRoutingPath, undefined);
  } finally {
    env.cleanup();
  }
});

test("project routing wins as a complete assignment and defaults to inherited Pi", () => {
  const env = fixture();
  try {
    writeAgent(path.join(env.agentDir, "agents", "reviewer.md"), { name: "reviewer" });
    fs.writeFileSync(
      path.join(env.agentDir, "subagents.json"),
      `${JSON.stringify({
        version: 1,
        agents: {
          reviewer: { harness: "claude", model: "opus", thinking: "high" },
        },
      })}\n`,
    );
    fs.mkdirSync(path.join(env.cwd, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(env.cwd, ".pi", "subagents.json"),
      `${JSON.stringify({ version: 1, agents: { reviewer: { harness: "pi" } } })}\n`,
    );

    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: true,
    });
    assert.deepEqual(effectiveAgentRouting(catalog, "reviewer"), {
      harness: "pi",
      scope: "project",
    });
    assert.deepEqual(resolveAgentSpawn(catalog, { agent: "reviewer" }), {
      agent: catalog.byName.get("reviewer"),
      harness: "pi",
    });
    assert.deepEqual(resolveAgentSpawn(catalog, {}), { harness: "pi" });
  } finally {
    env.cleanup();
  }
});

test("explicit routing overrides a profile and changing harness drops incompatible mapped details", () => {
  const env = fixture();
  try {
    writeAgent(path.join(env.agentDir, "agents", "reviewer.md"), { name: "reviewer" });
    fs.writeFileSync(
      path.join(env.agentDir, "subagents.json"),
      `${JSON.stringify({
        version: 1,
        agents: {
          reviewer: { harness: "claude", model: "opus", thinking: "high" },
        },
      })}\n`,
    );
    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: false,
    });

    const changedHarness = resolveAgentSpawn(catalog, {
      agent: "reviewer",
      harness: "pi",
    });
    assert.equal(changedHarness.harness, "pi");
    assert.equal(changedHarness.model, undefined);
    assert.equal(changedHarness.thinking, undefined);

    const explicit = resolveAgentSpawn(catalog, {
      agent: "reviewer",
      model: "sonnet",
      thinking: "medium",
    });
    assert.equal(explicit.harness, "claude");
    assert.equal(explicit.model, "sonnet");
    assert.equal(explicit.thinking, "medium");
  } finally {
    env.cleanup();
  }
});

test("routing writes are scoped, atomic, and removable", () => {
  const env = fixture();
  try {
    writeAgent(path.join(env.agentDir, "agents", "reviewer.md"), { name: "reviewer" });
    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: true,
    });

    writeAgentRouting(catalog, "user", "reviewer", {
      harness: "claude",
      model: "sonnet",
      thinking: "high",
    });
    assert.deepEqual(readAgentRoutingFile(catalog.userRoutingPath).agents.reviewer, {
      harness: "claude",
      model: "sonnet",
      thinking: "high",
    });

    writeAgentRouting(catalog, "project", "reviewer", { harness: "pi" });
    assert.deepEqual(
      readAgentRoutingFile(catalog.projectRoutingPath!).agents.reviewer,
      { harness: "pi" },
    );
    assert.equal(fs.statSync(catalog.projectRoutingPath!).mode & 0o777, 0o600);

    writeAgentRouting(catalog, "user", "reviewer", undefined);
    assert.equal(readAgentRoutingFile(catalog.userRoutingPath).agents.reviewer, undefined);
    assert.deepEqual(
      fs.readdirSync(path.dirname(catalog.userRoutingPath)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    env.cleanup();
  }
});

test("invalid or symlinked routing is rejected with a bounded configuration error", () => {
  const env = fixture();
  try {
    writeAgent(path.join(env.agentDir, "agents", "reviewer.md"), { name: "reviewer" });
    const routingPath = path.join(env.agentDir, "subagents.json");
    fs.writeFileSync(
      routingPath,
      '{"version":1,"agents":{"reviewer":{"harness":"unknown"}}}\n',
    );
    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: false,
    });
    assert.deepEqual(catalog.userRouting.agents, {});
    assert.equal(catalog.warnings[0], "Ignored invalid user routing file.");
    assert.match(catalog.routingErrors.user ?? "", /invalid harness/);
    assert.deepEqual(resolveAgentSpawn(catalog, { agent: "reviewer" }), {
      agent: catalog.byName.get("reviewer"),
      harness: "pi",
    });
    assert.throws(() => readAgentRoutingFile(routingPath), /invalid harness/);
    const backupPath = repairAgentRoutingFile(catalog, "user");
    assert.ok(backupPath && fs.existsSync(backupPath));
    assert.deepEqual(readAgentRoutingFile(routingPath), { version: 1, agents: {} });
    assert.equal(fs.statSync(routingPath).mode & 0o777, 0o600);

    fs.unlinkSync(routingPath);
    const target = path.join(env.root, "outside.json");
    fs.writeFileSync(target, '{"version":1,"agents":{}}\n');
    fs.symlinkSync(target, routingPath);
    assert.throws(() => readAgentRoutingFile(routingPath), /regular file, not a symlink/);
  } finally {
    env.cleanup();
  }
});

test("user routing canonicalizes the agent root and rejects a symlinked agents directory", () => {
  const env = fixture();
  try {
    const alias = path.join(env.root, "agent-home-alias");
    fs.symlinkSync(env.agentDir, alias);
    const outsideAgents = path.join(env.root, "user-outside-agents");
    writeAgent(path.join(outsideAgents, "escaped.md"), { name: "escaped" });
    fs.rmSync(path.join(env.agentDir, "agents"), { recursive: true, force: true });
    fs.symlinkSync(outsideAgents, path.join(env.agentDir, "agents"));

    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: alias,
      projectTrusted: false,
    });
    assert.equal(catalog.byName.has("escaped"), false);
    assert.equal(catalog.userRoutingPath, path.join(env.agentDir, "subagents.json"));
    assert.match(catalog.warnings[0] ?? "", /agents directory is a symlink/);

    writeAgentRouting(catalog, "user", "reviewer", { harness: "claude" });
    assert.deepEqual(readAgentRoutingFile(path.join(env.agentDir, "subagents.json")).agents, {
      reviewer: { harness: "claude" },
    });
  } finally {
    env.cleanup();
  }
});

test("project agent discovery and writes reject a symlinked config directory", () => {
  const env = fixture();
  try {
    const outsideAgents = path.join(env.root, "outside-agents");
    writeAgent(path.join(outsideAgents, "escaped.md"), { name: "escaped" });
    fs.mkdirSync(path.join(env.cwd, ".pi"), { recursive: true });
    fs.symlinkSync(outsideAgents, path.join(env.cwd, ".pi", "agents"));

    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: true,
    });
    assert.equal(catalog.byName.has("escaped"), false);
    assert.equal(catalog.projectTrusted, false);
    assert.equal(catalog.projectRoutingPath, undefined);
    assert.match(catalog.warnings[0] ?? "", /contains a symlink/);
    assert.throws(
      () => writeAgentRouting(catalog, "project", "escaped", { harness: "pi" }),
      /untrusted or its config path is unsafe/,
    );
  } finally {
    env.cleanup();
  }
});

test("catalog prompt lists agent names and effective routing without system prompt bodies", () => {
  const env = fixture();
  try {
    writeAgent(path.join(env.agentDir, "agents", "reviewer.md"), {
      name: "reviewer",
      description: 'Review <code> & "tests"',
      prompt: "SECRET ROLE BODY",
    });
    const catalog = loadAgentCatalog({
      cwd: env.cwd,
      agentDir: env.agentDir,
      projectTrusted: false,
    });
    const prompt = buildAgentCatalogPrompt(catalog)!;
    assert.match(prompt, /name="reviewer"/);
    assert.match(prompt, /harness="pi"/);
    assert.match(prompt, /Review &lt;code&gt; &amp; &quot;tests&quot;/);
    assert.doesNotMatch(prompt, /SECRET ROLE BODY/);
  } finally {
    env.cleanup();
  }
});
