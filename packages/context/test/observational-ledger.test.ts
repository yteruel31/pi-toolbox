import { describe, expect, it } from "vitest";
import { foldLedger } from "../src/observational/ledger/fold.js";
import { projectSources } from "../src/observational/ledger/projection.js";
import { FOLDED, OBSERVATIONS_DROPPED, OBSERVATIONS_RECORDED } from "../src/observational/ledger/types.js";
import { serializeSourceEntries } from "../src/observational/serialize.js";

const sources = { entryIds: ["u1"], ranges: [] };
const observation = (id: string, text = "remember") => ({ id, timestamp: "2025-01-01T00:00:00Z", priority: "high", text, sources });
const custom = (id: string, customType: string, data: unknown) => ({ type: "custom", id, customType, data });
describe("observational ledger", () => {
  it("folds new events deterministically and ignores malformed and other branches", () => {
    const branch: any[] = [custom("bad", OBSERVATIONS_RECORDED, {}), custom("r1", OBSERVATIONS_RECORDED, { version: 1, clock: 1, throughEntryId: "u1", records: [observation("aaaaaaaaaaaa"), { ...observation("bbbbbbbbbbbb"), supersedesIds: ["aaaaaaaaaaaa"] }] }), custom("d1", OBSERVATIONS_DROPPED, { version: 1, clock: 1, throughEntryId: "u1", ids: ["bbbbbbbbbbbb"] })];
    const folded = foldLedger(branch);
    expect(folded.observations).toEqual([]);
    expect(folded.malformedCount).toBe(1);
    expect(folded.clocks).toMatchObject({ observations: 1, drops: 1 });
    expect(foldLedger(branch.slice(0, 2)).observations.map((x) => x.id)).toEqual(["bbbbbbbbbbbb"]);
  });
  it("reconstructs superseded IDs from folded records so old records never reactivate", () => {
    const old = observation("aaaaaaaaaaaa", "old");
    const replacement = { ...observation("bbbbbbbbbbbb", "new"), supersedesIds: [old.id] };
    const folded = foldLedger([custom("f", FOLDED, { version: 1, clock: 2, throughEntryId: "u1", clocks: { observations: 2, reflections: 0, drops: 0, folds: 1 }, observations: [old, replacement], reflections: [], droppedIds: [] })] as any);
    expect(folded.observations.map((item) => item.id)).toEqual([replacement.id]);
    expect(folded.supersededIds).toContain(old.id);
  });

  it("projects inclusive ranges, reports invalid/missing endpoints, and excludes hidden context", () => {
    const branch: any[] = [{ type: "message", id: "u1", message: { role: "user", content: "request" } }, { type: "custom_message", id: "hidden", customType: "context.memory-injection", content: "secret" }, { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", name: "edit", arguments: { path: "x" } }] } }, { type: "message", id: "t1", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file" }] } }, { type: "custom_message", id: "op", content: "Updated file.ts" }];
    const projected = projectSources(branch, { entryIds: ["missing"], ranges: [{ startEntryId: "u1", endEntryId: "t1" }, { startEntryId: "t1", endEntryId: "u1" }, { startEntryId: "absent", endEntryId: "op" }] });
    expect(projected.requestedIds).toEqual(expect.arrayContaining(["u1", "hidden", "a1", "t1", "absent", "op"]));
    expect(projected.missingIds).toEqual(expect.arrayContaining(["missing", "absent"]));
    const text = serializeSourceEntries(projected.entries);
    expect(text).toContain("User: request");
    expect(text).toContain("Assistant: answer");
    expect(text).toContain("tool call edit");
    expect(text).toContain("Tool read: file");
    expect(text).toContain("Custom: Updated file.ts");
    expect(text).not.toContain("secret");
  });

  it("bounds source rendering at 50KiB and 2000 lines without splitting UTF-8", () => {
    const entries: any[] = Array.from({ length: 2_100 }, (_, index) => ({ type: "message", id: `u${index}`, message: { role: "user", content: `${index}:${"🙂".repeat(40)}` } }));
    const text = serializeSourceEntries(entries);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
    expect(text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(text).not.toContain("�");
  });
});
