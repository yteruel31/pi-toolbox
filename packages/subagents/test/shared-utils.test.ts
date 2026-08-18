import { describe, expect, it } from "vitest";
import { BoundedLog } from "../src/shared/bounded-log.js";
import { describeError } from "../src/shared/errors.js";
import { toDisplayTitle, truncateText } from "../src/shared/truncate.js";

describe("truncateText", () => {
  it("returns short text untouched", () => {
    expect(truncateText("hello", 10)).toBe("hello");
    expect(truncateText("exactly10!", 10)).toBe("exactly10!");
  });

  it("never exceeds maxChars, marker included", () => {
    for (const max of [30, 50, 100, 1_000]) {
      const out = truncateText("a".repeat(10_000), max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out).toContain("truncated");
    }
  });

  it("states how many characters were dropped", () => {
    const out = truncateText("a".repeat(100), 60);
    const match = /truncated (\d+) chars/.exec(out);
    expect(match).not.toBeNull();
    const kept = out.indexOf("…");
    expect(Number(match![1])).toBe(100 - kept);
  });

  it("degrades to a plain slice when maxChars cannot fit a marker", () => {
    expect(truncateText("abcdefgh", 3)).toBe("abc");
    expect(truncateText("abc", 0)).toBe("");
  });
});

describe("toDisplayTitle", () => {
  it("collapses whitespace and bounds length", () => {
    expect(toDisplayTitle("  review \n the   diff  ")).toBe("review the diff");
    expect(toDisplayTitle("t".repeat(500)).length).toBeLessThanOrEqual(60);
  });
});

describe("BoundedLog", () => {
  it("keeps the newest entries and counts dropped ones", () => {
    const log = new BoundedLog<number>(2);
    log.push(1);
    log.push(2);
    log.push(3);
    expect(log.entries()).toEqual([2, 3]);
    expect(log.dropped).toBe(1);
    expect(log.size).toBe(2);
  });

  it("rejects a non-positive capacity", () => {
    expect(() => new BoundedLog(0)).toThrow(RangeError);
  });

  it("returns defensive copies", () => {
    const log = new BoundedLog<number>(3);
    log.push(1);
    const copy = log.entries() as number[];
    copy.push(99);
    expect(log.entries()).toEqual([1]);
  });

  it("rehydrates from persisted entries", () => {
    const log = BoundedLog.from(2, [1, 2, 3], 5);
    expect(log.entries()).toEqual([2, 3]);
    expect(log.dropped).toBe(6); // 5 persisted + 1 overflow during rebuild
  });
});

describe("describeError", () => {
  it("uses Error messages and bounds them", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
    expect(describeError(new Error("x".repeat(2_000))).length).toBeLessThanOrEqual(500);
  });

  it("stringifies non-Error values", () => {
    expect(describeError("plain")).toBe("plain");
    expect(describeError(42)).toBe("42");
  });

  it("falls back to the error name for empty messages", () => {
    expect(describeError(new RangeError(""))).toBe("RangeError");
  });
});
