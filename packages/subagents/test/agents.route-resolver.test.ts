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
      agent: agent({ harness: "pi", model: "agent", effort: "max" }),
      parent: { model: "parent", thinking: "low" },
    });
    expect(route).toMatchObject({
      harness: "claude",
      model: "opus",
      thinking: "high",
      provenance: {
        harness: "saved-user",
        model: "saved-project",
        thinking: "saved-project",
      },
    });
  });

  it.each([
    ["explicit", { explicit: { harness: "claude" } }],
    ["saved-project", { projectRouting: { harness: "claude" } }],
    ["saved-user", { userRouting: { harness: "claude" } }],
    ["saved-user", { savedRouting: { harness: "claude" } }],
    ["agent-default", { agent: agent({ harness: "claude" }) }],
  ] as const)("selects the Claude harness from the %s layer", (provenance, layer) => {
    expect(resolver.resolve({
      explicit: {},
      ...layer,
      parent: { model: "parent", thinking: "high" },
    })).toMatchObject({
      harness: "claude",
      model: undefined,
      thinking: undefined,
      provenance: { harness: provenance },
    });
  });

  it("resolves every field through explicit, project, user, legacy, and agent priority", () => {
    const base = {
      agent: agent({ harness: "claude" as const, model: "agent", effort: "low" as const }),
      savedRouting: { harness: "pi" as const, model: "legacy", thinking: "medium" as const },
      userRouting: { harness: "claude" as const, model: "user", thinking: "high" as const },
      projectRouting: { harness: "pi" as const, model: "project", thinking: "xhigh" as const },
      parent: { model: "parent", thinking: "minimal" as const },
    };

    expect(resolver.resolve({ ...base, explicit: {
      harness: "claude", model: "explicit", thinking: "off",
    } })).toMatchObject({ harness: "claude", model: "explicit", thinking: "off" });
    expect(resolver.resolve({ ...base, explicit: {} })).toMatchObject({
      harness: "pi", model: "project", thinking: "xhigh",
    });
    expect(resolver.resolve({ ...base, explicit: {}, projectRouting: {} })).toMatchObject({
      harness: "claude", model: "user", thinking: "high",
    });
    expect(resolver.resolve({
      ...base, explicit: {}, projectRouting: {}, userRouting: {},
    })).toMatchObject({ harness: "pi", model: "legacy", thinking: "medium" });
    expect(resolver.resolve({
      ...base, explicit: {}, projectRouting: {}, userRouting: {}, savedRouting: {},
    })).toMatchObject({ harness: "claude", model: "agent", thinking: "low" });
  });

  it("uses Claude effort ahead of legacy thinking only at the agent-default layer", () => {
    const selected = agent({ harness: "claude", effort: "max", thinking: "medium" });
    expect(resolver.resolve({
      explicit: {}, agent: selected, parent: { model: undefined, thinking: "low" },
    }).thinking).toBe("max");
    expect(resolver.resolve({
      explicit: { thinking: "off" }, agent: selected,
      parent: { model: undefined, thinking: "low" },
    }).thinking).toBe("off");
    expect(resolver.resolve({
      explicit: {}, projectRouting: { thinking: "minimal" }, agent: selected,
      parent: { model: undefined, thinking: "low" },
    }).thinking).toBe("minimal");

    const oldAgent = agent({ harness: "claude", thinking: "high" });
    expect(resolver.resolve({
      explicit: {}, agent: oldAgent, parent: { model: undefined, thinking: "low" },
    }).thinking).toBe("high");
  });

  it("applies effort only after harness resolution and never infers Claude", () => {
    const defaults = agent({ harness: "claude", effort: "xhigh", thinking: "medium" });
    expect(resolver.resolve({
      explicit: { harness: "pi" }, agent: defaults,
      parent: { model: "parent", thinking: "low" },
    }).thinking).toBe("medium");
    expect(resolver.resolve({
      explicit: { harness: "claude" }, agent: agent({ harness: "pi", effort: "xhigh", thinking: "medium" }),
      parent: { model: "parent", thinking: "low" },
    }).thinking).toBe("xhigh");
    expect(resolver.resolve({
      explicit: {}, agent: agent({ effort: "max" }),
      parent: { model: "parent", thinking: "low" },
    })).toMatchObject({ harness: "pi", thinking: "low" });
  });

  it("normalizes only an agent-default Claude model inherit without falling back", () => {
    const claude = resolver.resolve({
      explicit: {}, agent: agent({ harness: "claude", model: "inherit" }),
      parent: { model: "parent-model", thinking: "high" },
    });
    expect(claude.model).toBeUndefined();
    expect(claude.provenance.model).toBe("agent-default");

    expect(resolver.resolve({
      explicit: { model: "inherit" }, agent: agent({ harness: "claude", model: "agent" }),
      parent: { model: "parent-model", thinking: "high" },
    }).model).toBe("inherit");
    expect(resolver.resolve({
      explicit: {}, projectRouting: { model: "inherit" },
      agent: agent({ harness: "claude", model: "agent" }),
      parent: { model: "parent-model", thinking: "high" },
    }).model).toBe("inherit");

    const pi = resolver.resolve({
      explicit: {}, agent: agent({ harness: "pi", model: "inherit" }),
      parent: { model: "parent-model", thinking: "high" },
    });
    expect(pi.model).toBe("inherit");
    expect(pi.provenance.model).toBe("agent-default");
    expect(resolver.resolve({
      explicit: {}, agent: agent({ harness: "pi" }),
      parent: { model: "parent-model", thinking: "high" },
    }).model).toBe("parent-model");
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
