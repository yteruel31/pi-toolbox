import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEventBus, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createGuardrailsExtension } from "../src/index.js";
import { CHILD_CHANNEL, type ChildRequest } from "../src/child-bridge.js";
import { HistoryStore } from "../src/history.js";
import { bridge, config } from "./helpers.js";
import { requestPiChildAssessment } from "../../subagents/src/harnesses/pi-assessment.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "guardrails-extension-"));
  const agentDir = join(root, "agent"); await mkdir(agentDir);
  await writeFile(join(agentDir, "guardrails.json"), JSON.stringify(config()));
  const bus = createEventBus();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => any>();
  const commands: string[] = [];
  let opened = 0;
  const pi = { events: bus, on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (name: string) => commands.push(name) } as unknown as ExtensionAPI;
  createGuardrailsExtension({ agentDir, bridge: bridge(), history: (path) => { opened++; return new HistoryStore(path); } })(pi);
  assert.equal(opened, 0, "factory must not allocate history");
  let asks = 0;
  const ctx = (id: string, hasUI = false): ExtensionContext => ({
    cwd: root, mode: hasUI ? "tui" : "print", hasUI, scopedModels: [], signal: undefined,
    isProjectTrusted: () => true, sessionManager: { getSessionId: () => id, getLeafId: () => "leaf" },
    ui: { notify() {}, select: async () => { asks++; return "Allow once"; } },
    abort: async () => {},
  }) as unknown as ExtensionContext;
  const emit = (name: string, c: ExtensionContext, event: any = {}) => handlers.get(name)?.(event, c);
  return { root, agentDir, bus, ctx, emit, asks: () => asks, commands, cleanup: async () => { await emit("session_shutdown", ctx("last")); await rm(root, { recursive: true }); } };
}
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

test("guardrails-absent protocol is inactive; a throwing provider fails closed", async () => {
  const bus = createEventBus();
  const request = { parentSessionId: "p", runId: "r", cwd: "/project", signal: new AbortController().signal };
  assert.equal(requestPiChildAssessment(bus, request), undefined);
  const unsub = bus.on(CHILD_CHANNEL, (data) => (data as ChildRequest).provide({ assess: async () => { throw Error("raw secret"); }, result() {} }));
  const gate = requestPiChildAssessment(bus, request)!;
  const block = await gate.assess({ toolName: "bash", toolCallId: "call", input: {}, childSessionId: "child" });
  assert.ok(block?.block); assert.doesNotMatch(block.reason, /raw secret/); unsub();
});
