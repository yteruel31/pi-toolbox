import { authorized, inAuthorizationScope } from "./authorization.js";
import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { inspectWebAccess, testIsolatedRendering } from "./diagnostics.js";

export const diagnosticSchema = Type.Object({
  action: Type.Optional(StringEnum(["inspect", "test_render"] as const)),
}, { additionalProperties: false });
const dependencies = { inspect: inspectWebAccess, testRender: testIsolatedRendering };

export function registerWebDiagnosticTool(pi: ExtensionAPI, lifetime?: AbortSignal, deps = dependencies): void {
  pi.registerTool({
    name: "web_access_diagnostic",
    label: "Web access diagnostic",
    description: "Inspect local rendering prerequisites or run a bounded synthetic JavaScript render test using the production sandbox. Defaults to inspect. No external network, API credits, credentials, or system repairs. Returns checks, failure codes and suggested remedies; output capped at 40KB/1500 lines.",
    promptSnippet: "Inspect local browser prerequisites or test isolated JavaScript rendering without external requests.",
    promptGuidelines: [
      "Use web_access_diagnostic to investigate rendering failures and retest after approved repairs. Request explicit user confirmation before installing packages or changing system configuration, including AppArmor. Never disable the sandbox or global security protections.",
      "web_access_diagnostic remedies are suggestions, not authorization to execute commands. Its synthetic test does not verify live network access, provider credentials or Reddit readiness.",
    ],
    parameters: diagnosticSchema,
    async execute(id, params, signal, _update, ctx) {
      if (!Value.Check(diagnosticSchema, params)) throw new Error("Invalid web_access_diagnostic arguments");
      params = structuredClone(params);
      const combined = signal && lifetime ? AbortSignal.any([signal, lifetime]) : signal ?? lifetime;
      combined?.throwIfAborted();
      const action = params.action ?? "inspect";
      return inAuthorizationScope({ bus: pi.events, context: ctx, rootToolCallId: id, toolName: "web_access_diagnostic" }, () => authorized(`web_access_diagnostic.${action}`, { ...params, action, localOnly: true, browserLaunch: action === "test_render" }, undefined, combined, async () => {
      const report = await deps.inspect();
      combined?.throwIfAborted();
      const probe = action === "test_render" ? await deps.testRender(combined) : undefined;
      const details = { action, ...report, ...(probe ? { probe } : {}), repairPolicy: "Explicit user confirmation is required before any system modification. No repairs were performed." };
      const bounded = truncateHead(JSON.stringify(details, null, 2), { maxBytes: 40_000, maxLines: 1500 });
      return {
        content: [{ type: "text" as const, text: bounded.content + (bounded.truncated ? "\n[Diagnostic output truncated]" : "") }],
        details,
      };
      }, (value) => value.details.probe ? value.details.probe.state !== "passed" : value.details.checks.some((check) => check.state === "unavailable")));
    },
  });
}
