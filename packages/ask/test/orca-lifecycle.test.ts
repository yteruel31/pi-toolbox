import test from "node:test";
import assert from "node:assert/strict";
import askExtension from "../src/index.ts";
import { ConfigStore } from "../src/config.ts";
import { normalizeAsk } from "../src/contracts.ts";
import { cancelledResult } from "../src/domain.ts";
import { makePayload, PAYLOAD_ENTRY } from "../src/persistence.ts";

const params = { questions: [{ id: "q", prompt: "Deploy where?", options: [{ value: "a", label: "A" }] }] };
const form = normalizeAsk(params).form!;

function harness(t: test.TestContext, outcome: "submit" | "cancel" | "abort" | "error") {
  const previous = process.env.ORCA_PANE_KEY;
  process.env.ORCA_PANE_KEY = "test:pane";
  t.after(() => { if (previous === undefined) delete process.env.ORCA_PANE_KEY; else process.env.ORCA_PANE_KEY = previous; });
  t.mock.method(ConfigStore.prototype, "ensureCreated", async () => true);
  const writes: unknown[] = [];
  t.mock.method(process.stderr, "write", ((chunk: unknown) => { writes.push(chunk); return true; }) as any);

  const handlers = new Map<string, Function[]>();
  const commands = new Map<string, any>();
  let tool: any;
  let sent = 0;
  const controller = new AbortController();
  const theme = new Proxy({}, { get: (_target, key) => key === "bold" ? (s: string) => s : (_color: string, s: string) => s });
  const ctx: any = {
    mode: "tui", cwd: process.cwd(), isIdle: () => true,
    sessionManager: { getBranch: () => [{ type: "custom", customType: PAYLOAD_ENTRY, data: makePayload("tool", params) }] },
    ui: {
      notify() {},
      custom(factory: any) {
        return new Promise((resolve, reject) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          queueMicrotask(() => {
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
    on(name: string, handler: Function) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    appendEntry() {},
    sendUserMessage() { sent++; },
  } as any);
  return {
    writes,
    sent: () => sent,
    tool: () => tool.execute("call", params, controller.signal, undefined, ctx),
    replay: () => commands.get("ask:replay").handler("", ctx),
    event: async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); },
  };
}

for (const outcome of ["submit", "cancel", "abort", "error"] as const) {
  test(`Orca ${outcome}: question close, settlement, later turn, and shutdown produce no Ask writes`, async (t) => {
    const h = harness(t, outcome);
    await h.event("agent_start");
    if (outcome === "error") await assert.rejects(h.tool(), /host failed/);
    else await h.tool();
    await new Promise((resolve) => setImmediate(resolve));
    await h.event("agent_end");
    await h.event("agent_settled");
    await h.event("agent_start");
    await h.event("agent_settled");
    await h.event("session_shutdown");
    assert.deepEqual(h.writes, []);
  });
}

test("Orca command replay, including an answered replay, emits no Ask writes", async (t) => {
  const h = harness(t, "submit");
  await h.replay();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent(), 1);
  await h.event("agent_start");
  await h.event("agent_settled");
  await h.event("session_shutdown");
  assert.deepEqual(h.writes, []);
});

test("Orca cancelled command replay emits no Ask writes or follow-up turn", async (t) => {
  const h = harness(t, "cancel");
  await h.replay();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sent(), 0);
  await h.event("session_shutdown");
  assert.deepEqual(h.writes, []);
});
