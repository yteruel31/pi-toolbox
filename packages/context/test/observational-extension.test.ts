import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { renderStatus, renderView } from "../src/observational/commands.js";
import { OBSERVATIONS_RECORDED } from "../src/observational/ledger/types.js";

describe("observational extension", () => {
  it("registers recall, both om commands, and one compaction hook after prior surfaces", () => {
    const tools: string[] = [], commands: string[] = [], events: string[] = [];
    extension({ registerTool: (tool: any) => tools.push(tool.name), registerCommand: (name: string) => commands.push(name), on: (name: string) => events.push(name), sendMessage: vi.fn() } as any);
    expect(tools.slice(0, 5)).toEqual(["memory_search", "memory_remember", "memory_forget", "memory_lessons", "memory_stats"]);
    expect(tools.at(-1)).toBe("recall");
    expect(commands).toEqual(expect.arrayContaining(["om:status", "om:view"]));
    expect(events.filter((event) => event === "session_before_compact")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining(["turn_end", "agent_settled"]));
    expect(events.filter((event) => event === "session_shutdown")).toHaveLength(1);
  });
  it("renders bounded status/view/full including clocks, provenance and malformed pressure", () => {
    const record = { id: "aaaaaaaaaaaa", timestamp: "2025-01-01T00:00:00Z", priority: "critical", text: "important", sources: { entryIds: ["u"], ranges: [] } };
    const entries: any[] = [{ type: "custom", id: "bad", customType: OBSERVATIONS_RECORDED, data: null }, { type: "custom", id: "e", customType: OBSERVATIONS_RECORDED, data: { version: 1, clock: 2, throughEntryId: "u", records: [record] } }];
    expect(renderStatus(entries)).toMatch(/malformed: 1[\s\S]*Clocks:/);
    expect(renderView(entries)).not.toContain("aaaaaaaaaaaa");
    expect(renderView(entries, true)).toContain("aaaaaaaaaaaa");
    const many = Array.from({ length: 2_100 }, (_, index) => ({ ...record, id: index.toString(16).padStart(12, "0"), text: `${index}:${"🙂".repeat(400)}` }));
    const large: any[] = [{ type: "custom", id: "large", customType: OBSERVATIONS_RECORDED, data: { version: 1, clock: 3, throughEntryId: "u", records: many } }];
    for (const output of [renderStatus(large), renderView(large), renderView(large, true)]) {
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(50 * 1024);
      expect(output.split("\n").length).toBeLessThanOrEqual(2_000);
      expect(output).not.toContain("�");
    }
  });
});
