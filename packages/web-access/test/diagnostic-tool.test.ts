import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWebDiagnosticTool } from "../src/diagnostic-tool.js";
import { BrowserFailure } from "../src/browser-environment.js";
import { testIsolatedRendering } from "../src/diagnostics.js";

function setup(lifetime?: AbortSignal) {
  let tool: ToolDefinition;
  let inspections = 0, probes = 0;
  let receivedSignal: AbortSignal | undefined;
  registerWebDiagnosticTool({ registerTool: (value: ToolDefinition) => { tool = value; } } as ExtensionAPI, lifetime, {
    inspect: async () => { inspections++; return { checks: [], remedies: ["Suggested repair"] }; },
    testRender: async (signal) => {
      probes++; receivedSignal = signal;
      return testIsolatedRendering(signal, async () => { throw new BrowserFailure("browser-missing"); });
    },
  });
  return {
    run: (params: unknown = {}, signal?: AbortSignal) => tool.execute("id", params, signal, undefined, {} as ExtensionContext),
    counts: () => ({ inspections, probes }),
    signal: () => receivedSignal,
  };
}
test("default inspection never launches a browser and reports the confirmation policy", async () => {
  const h = setup(); const result = await h.run();
  assert.deepEqual(h.counts(), { inspections: 1, probes: 0 });
  const report = JSON.parse(result.content.filter((block) => block.type === "text").map((block) => block.text).join(""));
  assert.equal(report.action, "inspect"); assert.equal(report.probe, undefined);
  assert.match(report.repairPolicy, /confirmation/);
});
test("render test returns machine-readable failure and fresh inspection without throwing it away", async () => {
  const h = setup(); const controller = new AbortController();
  const result = await h.run({ action: "test_render" }, controller.signal);
  assert.deepEqual(h.counts(), { inspections: 1, probes: 1 });
  assert.equal(h.signal(), controller.signal);
  assert.equal((result.details as { probe: { code: string } }).probe.code, "browser-missing");
});
test("mutated or unsupported actions are rejected before inspection", async () => {
  const h = setup();
  for (const params of [{ action: "repair" }, { action: "inspect", command: "sudo" }, null]) {
    await assert.rejects(h.run(params), /Invalid web_access_diagnostic/);
  }
  assert.deepEqual(h.counts(), { inspections: 0, probes: 0 });
});
test("tool cancellation and shutdown prevent any diagnostic work", async () => {
  const controller = new AbortController(); controller.abort();
  const h = setup(); await assert.rejects(h.run({ action: "test_render" }, controller.signal));
  assert.deepEqual(h.counts(), { inspections: 0, probes: 0 });
  const stopped = setup(controller.signal); await assert.rejects(stopped.run());
  assert.deepEqual(stopped.counts(), { inspections: 0, probes: 0 });
});
test("successful render tool preserves its proof and combines shutdown cancellation", async () => {
  let tool: ToolDefinition;
  const lifetime = new AbortController(), call = new AbortController();
  let received: AbortSignal | undefined;
  registerWebDiagnosticTool({ registerTool: (value: ToolDefinition) => { tool = value; } } as ExtensionAPI, lifetime.signal, {
    inspect: async () => ({ checks: [], remedies: [] }),
    testRender: async (signal) => { received = signal; return { state: "passed", summary: "Synthetic proof" }; },
  });
  const result = await tool!.execute("id", { action: "test_render" }, call.signal, undefined, {} as ExtensionContext);
  assert.equal((result.details as { probe: { state: string } }).probe.state, "passed");
  assert.equal(received?.aborted, false);
  lifetime.abort(); assert.equal(received?.aborted, true);
});
test("render probe preserves cancellation as a structured code", async () => {
  const controller = new AbortController();
  const result = await testIsolatedRendering(controller.signal, async () => { controller.abort(); throw new Error("private error"); });
  assert.equal(result.state, "cancelled"); assert.equal(result.code, "cancelled");
  assert.doesNotMatch(result.summary, /private error/);
});
