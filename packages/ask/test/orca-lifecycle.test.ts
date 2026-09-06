import test from "node:test";
import assert from "node:assert/strict";
import askExtension from "../src/index.ts";
import { ConfigStore } from "../src/config.ts";
import { normalizeAsk } from "../src/contracts.ts";
import { cancelledResult } from "../src/domain.ts";
import { WaitingNotifications } from "../src/notifications.ts";
import { makePayload, PAYLOAD_ENTRY } from "../src/persistence.ts";

const params = { questions: [{ id: "q", prompt: "Deploy where?", options: [{ value: "a", label: "A" }] }] };
const form = normalizeAsk(params).form!;
const enabled = { notifications: { enabled: true, channels: ["bell" as const] } };
const idle = { isIdle: () => true };

function recorder(env: NodeJS.ProcessEnv = { ORCA_PANE_KEY: "tab:leaf" }) {
  const writes: string[] = [];
  const notifications = new WaitingNotifications({ write: (s) => { writes.push(s); }, command: async () => {} }, env);
  return { notifications, writes, states: () => writes.map((s) => JSON.parse(s.slice(7, -1)).state) };
}

test("OSC lifecycle stays working until settled, including subsequent runs without asks", () => {
  const { notifications: n, states, writes } = recorder();
  n.agentStart(); n.settle(idle);
  assert.deepEqual(states(), []);
  const close = n.begin(form, enabled);
  n.settle(idle); // Even an idle command still owns a visible question.
  close(); close();
  n.settle({ isIdle: () => false }); // Retry, compaction, or another extension's new run.
  assert.deepEqual(states(), ["waiting", "working"]);
  n.settle(idle); n.settle(idle);
  assert.deepEqual(JSON.parse(writes.at(-1)!.slice(7, -1)), { state: "done", agentType: "pi" });
  n.agentStart(); n.settle(idle);
  assert.deepEqual(states(), ["waiting", "working", "done", "working", "done"]);
});

test("overlapping asks preserve the remaining preview and shutdown fences late cleanup", () => {
  const { notifications: n, states, writes } = recorder();
  const closeFirst = n.begin(form, enabled);
  const second = { ...form, questions: [{ ...form.questions[0]!, prompt: "Second?" }] };
  const closeSecond = n.begin(second, enabled);
  closeSecond();
  assert.equal(JSON.parse(writes.at(-1)!.slice(7, -1)).toolInput, "Deploy where?");
  n.agentStart(); n.settle(idle);
  n.dispose(); n.dispose(); closeFirst(); n.agentStart(); n.settle(idle); n.begin(form, enabled);
  assert.deepEqual(states(), ["waiting", "waiting", "waiting", "done"]);
});

test("no Orca, disabled notifications, and inherited child ownership never engage OSC lifecycle", () => {
  for (const env of [{}, { ORCA_PANE_KEY: "tab:leaf", ORCA_PI_STATUS_OWNED: "other-pid" }]) {
    const { notifications: n, writes } = recorder(env);
    n.begin(form, enabled)(); n.agentStart(); n.settle(idle); n.dispose();
    assert.deepEqual(writes, "ORCA_PANE_KEY" in env ? [] : ["\x07"]);
  }
  const { notifications: n, writes } = recorder();
  n.begin(form, { notifications: { ...enabled.notifications, enabled: false } })();
  n.agentStart(); n.settle(idle); n.dispose();
  assert.deepEqual(writes, []);
});

test("disabling notifications after a waiting signal still balances the retained status", () => {
  const { notifications: n, states } = recorder();
  const close = n.begin(form, enabled);
  n.begin(form, { notifications: { ...enabled.notifications, enabled: false } })();
  close(); n.settle(idle);
  assert.deepEqual(states(), ["waiting", "working", "done"]);
});

test("write failures remain best effort at every lifecycle boundary", () => {
  let fail = false;
  const writes: string[] = [];
  const n = new WaitingNotifications({ write(s) { if (fail) throw Error("tty closed"); writes.push(s); }, command: async () => {} }, { ORCA_PANE_KEY: "tab:leaf" });
  const close = n.begin(form, enabled);
  fail = true;
  assert.doesNotThrow(() => { close(); n.agentStart(); n.settle(idle); n.dispose(); });
  assert.equal(writes.length, 1);
});

// Exercise the real extension and showAskFlow, without touching user config or
// writing OSC into the test runner's actual Orca pane.
function harness(t: test.TestContext, outcome: "submit" | "cancel" | "abort" | "error" | "sync-error") {
  for (const [key, value] of Object.entries({ ORCA_PANE_KEY: "test:pane", ORCA_PI_STATUS_OWNED: String(process.pid) })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  t.mock.method(ConfigStore.prototype, "ensureCreated", async () => true);
  const writes: any[] = [];
  t.mock.method(process.stderr, "write", (s: string) => {
    assert.ok(s.startsWith("\x1b]9999;"));
    writes.push(JSON.parse(s.slice(7, -1)));
    return true;
  });
  const handlers = new Map<string, Function>();
  const commands = new Map<string, any>();
  let tool: any;
  let sent = 0;
  let failSend = false;
  let running = false;
  const controller = new AbortController();
  const theme = new Proxy({}, { get: (_target, key) => key === "bold" ? (s: string) => s : (_color: string, s: string) => s });
  const ctx: any = {
    mode: "tui", cwd: process.cwd(), isIdle: () => !running,
    sessionManager: { getBranch: () => [{ type: "custom", customType: PAYLOAD_ENTRY, data: makePayload("tool", params) }] },
    ui: {
      notify() {},
      custom(factory: any) {
        if (outcome === "sync-error") {
          factory({ requestRender() {} }, theme, {}, () => {});
          throw Error("host failed");
        }
        return new Promise((resolve, reject) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          queueMicrotask(() => {
            assert.equal(writes.at(-1)?.state, "waiting");
            if (outcome === "error") return reject(Error("host failed"));
            if (outcome === "abort") return controller.abort();
            const result = cancelledResult(form);
            if (outcome === "submit") result.details.cancelled = false;
            component.settle(result);
          });
        });
      },
    },
  };
  askExtension({
    events: { on: () => () => {}, emit() {} },
    registerTool(value: any) { tool = value; },
    registerCommand(name: string, value: any) { commands.set(name, value); },
    on(name: string, handler: Function) { handlers.set(name, handler); },
    appendEntry() {},
    sendUserMessage() { if (failSend) throw Error("send failed"); sent++; },
  } as any);
  return {
    writes, states: () => writes.map((s) => s.state), sent: () => sent,
    failSend: () => { failSend = true; },
    event(name: string) { return handlers.get(name)?.({}, ctx); },
    start() { running = true; handlers.get("agent_start")!({}, ctx); },
    settle() { running = false; handlers.get("agent_settled")!({}, ctx); },
    tool: () => tool.execute("call", params, controller.signal, undefined, ctx),
    replay: () => commands.get("ask:replay").handler("", ctx),
  };
}

for (const outcome of ["submit", "cancel", "abort", "error"] as const) {
  test(`tool ${outcome}: question cleanup is not agent completion`, async (t) => {
    const h = harness(t, outcome);
    h.start();
    if (outcome === "error") await assert.rejects(h.tool(), /host failed/);
    else await h.tool();
    assert.deepEqual(h.states(), ["waiting", "working"]);
    h.event("agent_end"); // Low-level end, including retries, must not emit done.
    assert.deepEqual(h.states(), ["waiting", "working"]);
    h.settle();
    assert.deepEqual(h.states(), ["waiting", "working", "done"]);
    h.event("session_shutdown");
    assert.equal(h.writes.length, 3);
  });
}

for (const outcome of ["submit", "cancel", "error"] as const) {
  test(`idle replay ${outcome} balances status without premature completion`, async (t) => {
    const h = harness(t, outcome);
    if (outcome === "error") await assert.rejects(h.replay(), /host failed/);
    else await h.replay();
    if (outcome === "submit") {
      assert.equal(h.sent(), 1);
      assert.deepEqual(h.states(), ["waiting", "working"]); // Prompt queued, not started yet.
      h.start(); h.settle();
    } else assert.equal(h.sent(), 0);
    assert.equal(h.writes.at(-1)?.state, "done");
  });
}

test("replay submission failure returns idle rather than stranding working", async (t) => {
  const h = harness(t, "submit"); h.failSend();
  await assert.rejects(h.replay(), /send failed/);
  assert.deepEqual(h.states(), ["waiting", "working", "done"]);
});

test("synchronous UI failure cannot emit a late waiting notification", async (t) => {
  const h = harness(t, "sync-error");
  await assert.rejects(h.replay(), /host failed/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.states(), []);
});
