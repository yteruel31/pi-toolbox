import { describe, expect, it } from "vitest";
import {
  DefaultRouteResolver,
  parseAgentMarkdown,
  WarningCollector,
} from "../src/agents/index.js";
import type { AgentDefinition } from "../src/agents/index.js";

function agent(defaults: AgentDefinition["defaults"]): AgentDefinition {
  return {
    name: "reviewer",
    description: "Review changes.",
    systemPrompt: "Review strictly.",
    defaults,
    source: { scope: "package", path: "/package/agents/reviewer.md", packageName: "pkg" },
  };
}

describe("DefaultRouteResolver", () => {
  const resolver = new DefaultRouteResolver();

  it("resolves each field independently with explicit, project, user, agent, and parent precedence", () => {
    const route = resolver.resolve({
      explicit: { model: "explicit-model" },
      projectRouting: { thinking: "xhigh" },
      userRouting: { harness: "claude", model: "user-model", thinking: "low" },
      agent: agent({ harness: "pi", model: "agent-model", thinking: "medium" }),
      parent: { model: "parent-model", thinking: "minimal" },
    });

    expect(route).toEqual({
      harness: "claude",
      model: "explicit-model",
      thinking: "xhigh",
      provenance: {
        harness: "saved-user",
        model: "explicit",
        thinking: "saved-project",
      },
    });
  });

  it("uses agent defaults before Pi parent inheritance", () => {
    expect(resolver.resolve({
      explicit: {},
      agent: agent({ model: "agent-model" }),
      parent: { model: "parent-model", thinking: "high" },
    })).toEqual({
      harness: "pi",
      model: "agent-model",
      thinking: "high",
      provenance: {
        harness: "parent",
        model: "agent-default",
        thinking: "parent",
      },
    });
  });

  it("does not pass a Pi parent model or thinking level to an otherwise unspecified Claude route", () => {
    expect(resolver.resolve({
      explicit: { harness: "claude" },
      parent: { model: "anthropic/pi-model", thinking: "high" },
    })).toEqual({
      harness: "claude",
      model: undefined,
      thinking: undefined,
      provenance: {
        harness: "explicit",
        model: "parent",
        thinking: "parent",
      },
    });
  });

  it("supports pre-merged saved routing with per-field provenance", () => {
    const route = resolver.resolve({
      explicit: {},
      savedRouting: { harness: "claude", model: "opus", thinking: "high" },
      savedRoutingProvenance: {
        harness: "saved-user",
        model: "saved-project",
        thinking: "saved-project",
      },
      parent: { model: "parent", thinking: "low" },
    });
    expect(route.provenance).toEqual({
      harness: "saved-user",
      model: "saved-project",
      thinking: "saved-project",
    });
  });
});

describe("agent frontmatter and warnings", () => {
  it("parses BOM, quoted flat scalars, and a closing YAML marker", () => {
    expect(parseAgentMarkdown(
      "\ufeff---\nname: 'reviewer'\ndescription: \"Review changes\"\nignored:\n  nested: value\n...\nPrompt body.\n",
    )).toEqual({
      ok: true,
      parsed: {
        frontmatter: {
          name: "reviewer",
          description: "Review changes",
          ignored: "",
        },
        body: "Prompt body.",
      },
    });
  });

  it("reports missing and unclosed frontmatter", () => {
    expect(parseAgentMarkdown("plain markdown")).toMatchObject({ ok: false });
    expect(parseAgentMarkdown("---\nname: reviewer")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("never closed"),
    });
  });

  it("deduplicates, truncates, and caps warnings", () => {
    const warnings = new WarningCollector(2, 10);
    warnings.add("same warning is long");
    warnings.add("same warning is long");
    warnings.add("second warning");
    warnings.add("third warning");
    expect(warnings.list()).toEqual([
      expect.stringMatching(/^same/),
      expect.stringMatching(/^second/),
      expect.stringMatching(/^… 1/),
    ]);
    expect(warnings.list().every((warning) => warning.length <= 10)).toBe(true);
  });
});
