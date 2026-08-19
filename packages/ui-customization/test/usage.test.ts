import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { calculateUsageTotals, formatTokens } from "../src/usage.js";

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

describe("footer usage", () => {
  it("matches Pi's cumulative entry semantics", () => {
    const entries = [
      { type: "message", message: { role: "assistant", usage: usage(100, 20, 80, 20, 0.1) } },
      { type: "message", message: { role: "toolResult", usage: usage(10, 2, 0, 0, 0.01) } },
      { type: "branch_summary", usage: usage(30, 4, 0, 0, 0.02) },
      { type: "compaction", usage: usage(40, 5, 0, 0, 0.03) },
    ] as unknown as SessionEntry[];

    expect(calculateUsageTotals(entries)).toEqual({
      input: 180,
      output: 31,
      cacheRead: 80,
      cacheWrite: 20,
      cost: 0.16,
      latestCacheHitRate: 40,
    });
  });

  it("uses the built-in footer token thresholds", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(9_999)).toBe("10.0k");
    expect(formatTokens(69_100)).toBe("69k");
    expect(formatTokens(1_370_000)).toBe("1.4M");
    expect(formatTokens(13_700_000)).toBe("14M");
  });
});
