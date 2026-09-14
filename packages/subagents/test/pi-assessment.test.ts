import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { DefaultResourceLoader, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { createOfficialPiResources } from "../src/harnesses/pi.js";
import { PI_CHILD_ASSESSMENT_CHANNEL, requestPiChildAssessment, type PiChildAssessment, type PiChildAssessmentRequest } from "../src/harnesses/pi-assessment.js";

describe("parent-provided Pi child assessment", () => {
  it("is inactive when absent and composes multiple parent restrictions without weakening a block", async () => {
    const bus = createEventBus();
    const request = { parentSessionId: "parent", cwd: "/project", runId: "run", signal: new AbortController().signal };
    expect(requestPiChildAssessment(bus, request)).toBeUndefined();
    const unsub = bus.on(PI_CHILD_ASSESSMENT_CHANNEL, (data) => {
      const r = data as PiChildAssessmentRequest;
      expect(r.parentSessionId).toBe("parent");
      r.provide({ assess: async () => undefined, result() {} });
      r.provide({ assess: async () => ({ block: true, reason: "restriction" }), result() {} });
    });
    const gate = requestPiChildAssessment(bus, request)!;
    expect(await gate.assess({ toolName: "bash", toolCallId: "call", input: {}, childSessionId: "child" })).toEqual({ block: true, reason: "restriction" });
    unsub(); expect(requestPiChildAssessment(bus, request)).toBeUndefined();
  });
  it.each([false, true])("keeps configured extensions isolated and allowlist first with assessment=%s", async (enabled) => {
    const root = await mkdtemp(join(tmpdir(), "pi-child-assessment-"));
    const cwd = join(root, "project"); const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(join(cwd, ".pi/extensions/never.ts"), "throw new Error('must not load project extension');");
    await writeFile(join(agentDir, "extensions/never.ts"), "throw new Error('must not load parent extension');");
    const gate: PiChildAssessment = { assess: vi.fn(async () => ({ block: true as const, reason: "Parent Ask blocks a worker" })), result: vi.fn() };
    try {
      const resources = await createOfficialPiResources({ cwd, agentDir, projectTrusted: true, systemPrompt: undefined, tools: ["read"], assessment: enabled ? gate : undefined });
      const loader = resources.resourceLoader as DefaultResourceLoader;
      const extensions = loader.getExtensions();
      expect(extensions.errors).toEqual([]);
      expect(extensions.extensions.map((e) => e.path)).toEqual(["<inline:pi-subagents-child-safety>"]);
      const safety = extensions.extensions[0]!;
      const ctx = { sessionManager: { getSessionId: () => "child-session" } } as unknown as ExtensionContext;
      const handler = safety.handlers.get("tool_call")![0]!;
      const forbidden = await handler({ type: "tool_call", toolName: "bash", toolCallId: "blocked", input: { command: "echo safe" } }, ctx);
      expect(forbidden).toMatchObject({ block: true, terminate: true });
      expect(gate.assess).not.toHaveBeenCalled();
      const read = { type: "tool_call" as const, toolName: "read" as const, toolCallId: "read", input: { path: "README.md" } };
      const result = await handler(read, ctx);
      if (enabled) {
        expect(result).toMatchObject({ block: true, reason: "Parent Ask blocks a worker" });
        expect(gate.assess).toHaveBeenCalledWith({ ...read, childSessionId: "child-session" });
        const report = safety.handlers.get("tool_result")![0]!;
        await report({ type: "tool_result", toolName: "read", toolCallId: "read", input: read.input, content: [], details: {}, isError: true }, ctx);
        expect(gate.result).toHaveBeenCalledWith({ toolCallId: "read", childSessionId: "child-session", isError: true });
      } else {
        expect(result).toBeUndefined(); expect(safety.handlers.has("tool_result")).toBe(false);
      }
    } finally { await rm(root, { recursive: true }); }
  });
});
