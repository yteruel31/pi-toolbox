import { describe, expect, it } from "vitest";
import { recall } from "../src/observational/recall.js";
import { FOLDED, OBSERVATIONS_DROPPED, OBSERVATIONS_RECORDED, REFLECTIONS_RECORDED } from "../src/observational/ledger/types.js";
const source = { type: "message", id: "u1", message: { role: "user", content: "exact request" } };
const base = { timestamp: "2025-01-01T00:00:00Z", priority: "high", sources: { entryIds: ["u1"], ranges: [] } };
const event = (id: string, customType: string, data: any) => ({ type: "custom", id, customType, data });
const entries: any[] = [source, event("o", OBSERVATIONS_RECORDED, { version: 1, clock: 1, throughEntryId: "u1", records: [{ ...base, id: "aaaaaaaaaaaa", text: "request" }] }), event("r", REFLECTIONS_RECORDED, { version: 1, clock: 1, throughEntryId: "u1", records: [{ ...base, id: "bbbbbbbbbbbb", text: "preference", supportingObservationIds: ["aaaaaaaaaaaa"] }] })];
describe("recall", () => {
  it("validates exact ids and resolves active observations/reflections with details", () => {
    expect(recall(entries, "bad").details.status).toBe("invalid_id");
    expect(recall(entries, "cccccccccccc").details.status).toBe("unknown");
    expect(recall(entries, "aaaaaaaaaaaa")).toMatchObject({ details: { status: "active", kind: "observation" } });
    expect(recall(entries, "bbbbbbbbbbbb").text).toContain("exact request");
  });
  it("returns actionable dropped and superseded status without searching elsewhere", () => {
    const dropped = [...entries, event("d", OBSERVATIONS_DROPPED, { version: 1, clock: 1, throughEntryId: "u1", ids: ["aaaaaaaaaaaa", "dddddddddddd"] })];
    expect(recall(dropped, "aaaaaaaaaaaa")).toMatchObject({ details: { status: "dropped" } });
    expect(recall(dropped, "dddddddddddd")).toMatchObject({ details: { status: "dropped" } });
    const superseded = [...entries, event("o2", OBSERVATIONS_RECORDED, { version: 1, clock: 2, throughEntryId: "u1", records: [{ ...base, id: "cccccccccccc", text: "new", supersedesIds: ["aaaaaaaaaaaa"] }] })];
    expect(recall(superseded, "aaaaaaaaaaaa")).toMatchObject({ details: { status: "superseded", kind: "observation" } });
  });

  it("recalls active observations and reflections stored only in a folded snapshot", () => {
    const observation = { ...base, id: "aaaaaaaaaaaa", text: "folded observation" };
    const reflection = { ...base, id: "bbbbbbbbbbbb", text: "folded reflection", supportingObservationIds: [observation.id] };
    const folded = [source, event("f", FOLDED, { version: 1, clock: 1, throughEntryId: "u1", clocks: { observations: 4, reflections: 3, drops: 2, folds: 0 }, observations: [observation], reflections: [reflection], droppedIds: ["dddddddddddd"] })];
    expect(recall(folded, observation.id)).toMatchObject({ text: expect.stringContaining("exact request"), details: { status: "active", kind: "observation" } });
    expect(recall(folded, reflection.id)).toMatchObject({ details: { status: "active", kind: "reflection" } });
    expect(recall(folded, "dddddddddddd")).toMatchObject({ details: { status: "dropped" } });
  });
});
