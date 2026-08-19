import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { FooterModel } from "../src/model.js";
import { renderFooter } from "../src/render.js";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;

function model(overrides: Partial<FooterModel> = {}): FooterModel {
  return {
    sessionName: "Refine payment details",
    mcp: { connected: 2, enabled: 3, authRequired: 1, errors: 0, disabled: 1 },
    path: "~/dev/pi-toolbox",
    branch: "feat/footer",
    usage: {
      input: 13_700_000,
      output: 192_000,
      cacheRead: 69_000,
      cacheWrite: 1_000,
      cost: 4.21,
      latestCacheHitRate: 98.8,
    },
    context: { tokens: 69_100, contextWindow: 70_600, percent: 97.9 },
    modelName: "gpt-5.6-sol",
    provider: "openai",
    providerCount: 2,
    thinking: "high",
    subagents: { running: 0, completed: 1, error: 0 },
    extensionStatuses: new Map([
      ["session-title", "session title"],
      ["mcp-status", "MCP raw"],
      ["subagents", "subagents raw"],
      ["zed-context", "2 selected lines"],
    ]),
    ...overrides,
  };
}

describe("structured footer rendering", () => {
  it.each([30, 40, 59, 60, 80, 120, 200])("never exceeds a width of %i", (width) => {
    const lines = renderFooter(model(), theme, width);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  });

  it("shows every owned column when enough room is available", () => {
    const lines = renderFooter(model(), theme, 200);
    expect(lines[0]).toContain("SESSION");
    expect(lines[0]).toContain("MCPS");
    expect(lines[0]).toContain("PATH");
    expect(lines[0]).toContain("CONTEXT");
    expect(lines[0]).toContain("MODEL");
    expect(lines[0]).toContain("THINKING");
    expect(lines[0]).toContain("SUB-AGENTS");
  });

  it("uses the compact fallback below the breakpoint", () => {
    const lines = renderFooter(model({ extensionStatuses: new Map() }), theme, 40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Refine");
    expect(lines[0]).not.toContain("SESSION");
  });

  it("preserves unabsorbed extension statuses", () => {
    const lines = renderFooter(model(), theme, 200);
    const statusLine = lines.at(-1)!;
    expect(statusLine).toContain("2 selected lines");
    expect(statusLine).not.toContain("session title");
    expect(statusLine).not.toContain("MCP raw");
    expect(statusLine).not.toContain("subagents raw");
  });

  it("keeps raw owner statuses when structured events are unavailable", () => {
    const lines = renderFooter(model({ mcp: undefined, subagents: undefined }), theme, 200);
    const statusLine = lines.at(-1)!;
    expect(statusLine).toContain("MCP raw");
    expect(statusLine).toContain("subagents raw");
  });

  it.each([50, 60])("keeps owner statuses when width %i cannot guarantee their columns", (width) => {
    const lines = renderFooter(model(), theme, width);
    const statusLine = lines.at(-1)!;
    expect(statusLine).toContain("MCP raw");
    expect(statusLine).toContain("subagents raw");
  });

  it("omits empty owner columns", () => {
    const lines = renderFooter(model({
      mcp: { connected: 0, enabled: 0, authRequired: 0, errors: 0, disabled: 0 },
      subagents: { running: 0, completed: 0, error: 0 },
      extensionStatuses: new Map(),
    }), theme, 200);
    expect(lines.join("\n")).not.toContain("MCPS");
    expect(lines.join("\n")).not.toContain("SUB-AGENTS");
  });

  it("prioritizes context occupancy before optional usage details", () => {
    const lines = renderFooter(model({ extensionStatuses: new Map() }), theme, 80);
    expect(lines[1]).toContain("97.9%");
  });

  it("does not show a cache hit rate when caching is unused", () => {
    const base = model({ extensionStatuses: new Map() });
    const lines = renderFooter({
      ...base,
      usage: { ...base.usage, cacheRead: 0, cacheWrite: 0, latestCacheHitRate: 0 },
    }, theme, 200);
    expect(lines.join("\n")).not.toContain("CH0.0%");
  });
});
