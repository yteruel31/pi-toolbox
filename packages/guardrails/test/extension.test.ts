import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGuardrailsExtension } from "../src/index.js";
import { CHILD_CHANNEL, type ChildRequest } from "../src/child-bridge.js";
import { HistoryStore } from "../src/history.js";
import { bridge, config, entry } from "./helpers.js";
import { requestPiChildAssessment } from "../../subagents/src/harnesses/pi-assessment.js";

async function fixture(disabled = false) {
  const root = await mkdtemp(join(tmpdir(), "guardrails-extension-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  await writeFile(join(agentDir, "guardrails.json"), JSON.stringify(config({enabled: !disabled})));
  const bus = createEventBus();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands: string[] = [];
  const commandHandlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const tools: string[] = [];
  const toolDefinitions = new Map<string, any>();
  let opened = 0;
  let history: HistoryStore | undefined;
  let modelCalls = 0;
  const pi = {
    events: bus,
    on: (name: string, handler: any) => handlers.set(name, handler),
    registerCommand: (name: string, options: any) => { commands.push(name); commandHandlers.set(name, options.handler); },
    registerTool: (tool: any) => { tools.push(tool.name); toolDefinitions.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  createGuardrailsExtension({ agentDir, bridge: disabled ? { resolve: () => ({ model: { provider: "fake", id: "judge" } as any, route: "fake/judge" }), complete: async () => { modelCalls++; throw new Error("model should not be called"); } } : bridge(), history: (path) => { opened++; history = new HistoryStore(path); return history; } })(pi);
  assert.equal(opened, 0, "factory must not allocate history");
  assert(tools.includes("guardrails_history"), "guardrails_history tool must be registered during factory");
  let asks = 0;
  const ctx = (id: string, hasUI = false): ExtensionContext => ({
    cwd: root, mode: hasUI ? "tui" : "print", hasUI, scopedModels: [], signal: undefined,
    isProjectTrusted: () => true, sessionManager: { getSessionId: () => id, getLeafId: () => "leaf" },
    ui: { notify() {}, select: async () => { asks++; return "Allow once"; } },
    abort: async () => {},
  }) as unknown as ExtensionContext;
  const emit = (name: string, c: ExtensionContext, event: any = {}) => handlers.get(name)?.(event, c);
  return { root, agentDir, bus, ctx, emit, asks: () => asks, commands, commandHandlers, toolDefinitions, history: () => history, modelCalls: () => modelCalls, cleanup: async () => { await emit("session_shutdown", ctx("last")); await rm(root, { recursive: true }); } };
}
test("real extension lifecycle: guardrails_history tool executes with session lifecycle isolation", async () => {
  const { randomUUID } = await import("node:crypto");
  const f = await fixture(true);
  try {
    const tool = f.toolDefinitions.get("guardrails_history");
    assert.ok(tool, "guardrails_history tool registered");

    const execute = (args: any, ctx: ExtensionContext) => tool.execute("history-read", args, undefined, undefined, ctx);

    const ctx1 = f.ctx("session-1", false);
    await assert.rejects(execute({action: "list"}, ctx1), {message: /unavailable|missing/i}, "list rejects before session_start");

    await f.emit("session_start", ctx1);

    const seedEntry = f.history()!.put({
      id: randomUUID(),
      at: Date.now(),
      updatedAt: Date.now(),
      sessionId: "session-1",
      project: f.root,
      cwd: f.root,
      actor: { kind: "main" },
      callId: randomUUID(),
      tool: "bash",
      summary: "seed entry for testing",
      target: "/project",
      operation: "test",
      action: "Ask",
      choice: "allow-once",
      origin: "policy",
      reason: "test reason",
      policyIds: ["test-policy"],
      historyIds: [],
      state: "allowed",
      execution: "not-observed",
    });

    const configPath = join(f.agentDir, "guardrails.json");
    const configBefore = await (await import("node:fs/promises")).readFile(configPath, "utf8");
    const historyBefore = f.history()!.list();

    const listResult = await execute({action: "list", filter: {decision: "Ask"}}, ctx1);
    assert.ok(listResult.content && listResult.content[0].type === "text", "list result has text content");
    const listData = JSON.parse(listResult.content[0].text);
    assert.equal(listData.entries.length, 1, "filtered list returns seeded Ask entry");
    assert.equal(listData.entries[0].id, seedEntry.id, "entry id matches");
    assert.equal(f.asks(), 0, "no model calls");
    assert.equal(f.modelCalls(), 0, "disabled bridge never called");

    await f.emit("session_shutdown", ctx1);

    const configAfter = await (await import("node:fs/promises")).readFile(configPath, "utf8");
    assert.equal(configBefore, configAfter, "config unchanged after shutdown");

    await assert.rejects(execute({action: "list"}, ctx1), {message: /unavailable|missing|session mismatch/i}, "list rejects after session_shutdown");

    const ctx2 = f.ctx("session-2", false);
    await assert.rejects(execute({action: "list"}, ctx2), {message: /unavailable|missing|session mismatch/i}, "ctx2 rejects before its session_start");

    await f.emit("session_start", ctx2);

    const listCtx2 = await execute({action: "list", scope: "global"}, ctx2);
    const listCtx2Data = JSON.parse(listCtx2.content[0].text);
    assert.equal(listCtx2Data.entries.length, 1, "ctx2 global list includes seeded entry");
    assert.equal(listCtx2Data.entries[0].id, seedEntry.id, "ctx2 sees seeded entry id");

    const toolsCount = f.toolDefinitions.size;
    assert.equal(toolsCount, 1, "exactly one tool (guardrails_history) registered");

    await f.emit("session_shutdown", ctx2);

    await assert.rejects(execute({action: "list"}, ctx2), {message: /unavailable|missing|session mismatch/i}, "ctx2 rejects after its own shutdown");
  } finally { await f.cleanup(); }
});

test("parent extension and real subagents protocol compose, workers never open UI and attribution survives result updates", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("parent", true); await f.emit("session_start", ctx);
    assert.deepEqual(f.commands, ["guardrails"]);
    assert.equal(requestPiChildAssessment(f.bus, { parentSessionId: "wrong", runId: "r", cwd: f.root, signal: new AbortController().signal }), undefined);
    const gates = ["one", "two"].map((runId) => requestPiChildAssessment(f.bus, { parentSessionId: "parent", runId, profile: "worker", cwd: f.root, signal: new AbortController().signal })!);
    await Promise.all(gates.map((gate, i) => gate.assess({ toolName: "bash", toolCallId: `call-${i}`, input: { command: "git reset --hard" }, childSessionId: `child-${i}` })));
    assert.equal(f.asks(), 0);
    await f.emit("tool_call", ctx, { toolName: "bash", toolCallId: "main-call", input: { command: "git reset --hard" } });
    assert.equal(f.asks(), 1);
    assert.equal(await gates[0].assess({ toolName: "bash", toolCallId: "safe", input: { command: "git status" }, childSessionId: "child-0" }), undefined);
    gates[0].result({ toolCallId: "safe", childSessionId: "child-0", isError: false });
    const history = new HistoryStore(join(f.agentDir, "guardrails/history.sqlite"));
    try {
      const entries = history.list(); assert.equal(entries.length, 4); assert.ok(entries.every((e) => e.sessionId === "parent"));
      assert.equal(entries.find((e) => e.callId === "safe")?.execution, "reported-success");
      assert.equal(entries.filter((e) => e.actor.kind === "subagent").length, 3);
    } finally { history.close(); }
    await f.emit("session_shutdown", ctx);
    assert.ok((await gates[0].assess({ toolName: "bash", toolCallId: "late", input: {}, childSessionId: "child-0" }))?.block);
    assert.equal(requestPiChildAssessment(f.bus, { parentSessionId: "parent", runId: "new", cwd: f.root, signal: new AbortController().signal }), undefined);
    await f.emit("session_start", f.ctx("fork"));
    assert.equal(requestPiChildAssessment(f.bus, { parentSessionId: "parent", runId: "old", cwd: f.root, signal: new AbortController().signal }), undefined);
  } finally { await f.cleanup(); }
});
test("real Pi worker gate allows read-only and unresolved no-match while blocking protected writes", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("shell-parent", true); await f.emit("session_start", ctx);
    const gate = requestPiChildAssessment(f.bus, { parentSessionId: "shell-parent", runId: "shell-worker", cwd: f.root, signal: new AbortController().signal })!;
    for (const command of ["rg guardrails packages/guardrails/src", "git status --short -- guardrails.json"]) {
      assert.equal(await gate.assess({ toolName: "bash", toolCallId: command, input: { command }, childSessionId: "child" }), undefined);
    }
    assert.equal(await gate.assess({ toolName: "bash", toolCallId: "opaque", input: { command: "custom-writer .pi/guardrails.json" }, childSessionId: "child" }), undefined);
    assert.ok((await gate.assess({ toolName: "bash", toolCallId: "redirection", input: { command: "echo x > .pi/guardrails.json" }, childSessionId: "child" }))?.block);
    assert.equal(f.asks(), 0);
    const history = new HistoryStore(join(f.agentDir, "guardrails/history.sqlite"));
    try {
      assert.ok(history.list().some((entry) => entry.action === "Allow"));
      assert.ok(history.list().some((entry) => entry.action === "Deny" && entry.policyIds.includes("builtin.self-protection")));
    } finally { history.close(); }
  } finally { await f.cleanup(); }
});

test("resume retains session history while fork gets its own current-session attribution", async () => {
  const f = await fixture();
  try {
    await f.emit("session_start", f.ctx("same"));
    await f.emit("tool_call", f.ctx("same"), { toolName: "bash", toolCallId: "call", input: { command: "git status" } });
    await f.emit("session_shutdown", f.ctx("same"));
    await f.emit("session_start", f.ctx("same"));
    await f.emit("tool_call", f.ctx("same"), { toolName: "bash", toolCallId: "call2", input: { command: "git status" } });
    await f.emit("session_shutdown", f.ctx("same")); await f.emit("session_start", f.ctx("fork"));
    await f.emit("tool_call", f.ctx("fork"), { toolName: "read", toolCallId: "call", input: { path: "README.md" } });
    const history = new HistoryStore(join(f.agentDir, "guardrails/history.sqlite"));
    try { assert.equal(history.list().filter((e) => e.sessionId === "same").length, 2); assert.equal(history.list().filter((e) => e.sessionId === "fork").length, 1); } finally { history.close(); }
  } finally { await f.cleanup(); }
});
test("Deny and stop is recorded before native abort can cancel the approval promise", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const ctx = f.ctx("stop", true);
    ctx.signal = controller.signal;
    ctx.ui.select = async () => "Deny and stop";
    ctx.abort = () => { controller.abort(); };
    await f.emit("session_start", ctx);
    const block = await f.emit("tool_call", ctx, { toolName: "bash", toolCallId: "stop-call", input: { command: "git reset --hard" } });
    assert.equal(block.terminate, true); assert.equal(controller.signal.aborted, true);
    const history = new HistoryStore(join(f.agentDir, "guardrails/history.sqlite"));
    try { assert.equal(history.list()[0].choice, "deny-stop"); } finally { history.close(); }
  } finally { await f.cleanup(); }
});

test("command stages coverage and judge toggles, rejects cancelled saves, and only persists a confirmed Save", async () => {
  const f = await fixture();
  try {
    const ctx = f.ctx("setup", true);
    const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text };
    let screens = 0, accept = false, save = false;
    ctx.ui.confirm = async () => accept;
    ctx.ui.custom = (async (factory: any) => new Promise((done) => {
      const panel = factory({ terminal: { rows: 40 }, requestRender() {} }, theme, { matches: () => false }, done);
      if (screens++ === 0) {
        panel.handleInput("\x1b[B"); panel.handleInput("\r"); // Bash Off
        for (let i = 0; i < 6; i++) panel.handleInput("\x1b[B");
        panel.handleInput("\r"); // Judge Off
        panel.handleInput(save ? "\x13" : "\x1b");
      } else panel.handleInput("\x1b");
    })) as typeof ctx.ui.custom;
    await f.emit("session_start", ctx);
    const load = async () => JSON.parse(await (await import("node:fs/promises")).readFile(join(f.agentDir, "guardrails.json"), "utf8"));
    for (const mode of ["close", "cancel-save", "save"]) {
      screens = 0; save = mode !== "close"; accept = mode === "save";
      await f.commandHandlers.get("guardrails")!("", ctx);
      assert.equal((await load()).coverage.bash, mode !== "save");
      assert.equal((await load()).judgeEnabled, mode !== "save");
    }
  } finally { await f.cleanup(); }
});

test("guardrails-absent protocol is inactive; a throwing provider fails closed", async () => {
  const bus = createEventBus();
  const request = { parentSessionId: "p", runId: "r", cwd: "/project", signal: new AbortController().signal };
  assert.equal(requestPiChildAssessment(bus, request), undefined);
  const unsub = bus.on(CHILD_CHANNEL, (data) => (data as ChildRequest).provide({ assess: async () => { throw Error("raw secret"); }, result() {} }));
  const gate = requestPiChildAssessment(bus, request)!;
  const block = await gate.assess({ toolName: "bash", toolCallId: "call", input: {}, childSessionId: "child" });
  assert.ok(block?.block); assert.doesNotMatch(block.reason, /raw secret/); unsub();
});
