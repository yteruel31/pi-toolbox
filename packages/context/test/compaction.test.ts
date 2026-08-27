import { describe, expect, it } from "vitest";
import { compactObservational } from "../src/observational/compaction.js";
import { OBSERVATIONS_RECORDED } from "../src/observational/ledger/types.js";
const preparation = { previousSummary: "previous", firstKeptEntryId: "keep", tokensBefore: 123, fileOps: { readFiles: ["x"] } };
const record = { id: "aaaaaaaaaaaa", timestamp: "2025-01-01T00:00:00Z", priority: "high", text: "x".repeat(100_000), sources: { entryIds: ["u"], ranges: [] } };
describe("observational compaction", () => {
  it("falls back when there is no fresh ledger state and tolerates malformed entries", () => {
    expect(compactObservational([], preparation)).toBeUndefined();
    expect(compactObservational([{ type: "custom", id: "bad", customType: OBSERVATIONS_RECORDED, data: {} }] as any, preparation)).toBeUndefined();
  });
  it("combines previous summary, preserves metadata/details, and closes bounded wrappers without model access", () => {
    const value = compactObservational([{ type: "custom", id: "e", customType: OBSERVATIONS_RECORDED, data: { version: 1, clock: 1, throughEntryId: "u", records: [{ ...record, text: "valid concise text" }] } }] as any, { ...preparation, previousSummary: "🙂".repeat(100_000) })!;
    expect(value).toMatchObject({ firstKeptEntryId: "keep", tokensBefore: 123, details: { readFiles: ["x"], observational: { version: 1, throughEntryId: "u", malformedCount: 0 } } });
    expect(value.summary).toContain("valid concise text");
    expect(value.summary).toMatch(/^<context-compaction>/);
    expect(value.summary.endsWith("</context-compaction>")).toBe(true);
    expect(Buffer.byteLength(value.summary)).toBeLessThanOrEqual(50 * 1024);
    expect(value.summary.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(value.summary).not.toContain("�");
    expect(Object.keys(value)).toEqual(["summary", "firstKeptEntryId", "tokensBefore", "details"]);
  });
});
