import { describe, expect, it } from "vitest";
import { readMcpStatusEvent, readSubagentStatusEvent } from "../src/events.js";

describe("toolbox status events", () => {
  it("accepts versioned MCP counts and clear events", () => {
    const counts = { connected: 2, enabled: 3, authRequired: 1, errors: 0, disabled: 4 };
    expect(readMcpStatusEvent({ v: 1, counts })).toEqual(counts);
    expect(readMcpStatusEvent({ v: 1, counts: null })).toBeNull();
  });

  it("accepts versioned subagent counts and rejects malformed payloads", () => {
    const counts = { running: 1, completed: 2, error: 0 };
    expect(readSubagentStatusEvent({ v: 1, counts })).toEqual(counts);
    expect(readSubagentStatusEvent({ v: 2, counts })).toBeUndefined();
    expect(readSubagentStatusEvent({ v: 1, counts: { ...counts, running: -1 } })).toBeUndefined();
    expect(readSubagentStatusEvent("invalid")).toBeUndefined();
  });
});
