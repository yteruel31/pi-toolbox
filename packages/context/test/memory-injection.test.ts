import { describe, expect, it, vi } from "vitest";

import {
  buildMemoryInjection,
  hasMemoryInjection,
  injectMemoryOnce,
} from "../src/memory/injector.js";

function store(facts: any[] = [], lessons: any[] = []) {
  return { listFacts: () => facts, listLessons: () => lessons } as any;
}

describe("memory injection", () => {
  it("orders facts before lessons and stays under 8KiB", () => {
    const out = buildMemoryInjection(
      store(
        [{ key: "pref.editor", value: "vim" }],
        [{ rule: "Test first", category: "general", negative: false }]
      ),
      "/project"
    );
    expect(out.text.indexOf("pref.editor")).toBeLessThan(
      out.text.indexOf("Applicable lessons")
    );
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(8 * 1024);
  });

  it("always closes a truncated wrapper and emits a marker", () => {
    const facts = Array.from({ length: 100 }, (_, index) => ({
      key: `fact.${index}`,
      value: "x".repeat(200),
    }));
    const out = buildMemoryInjection(store(facts), "/project", 1024);
    expect(out.details.truncated).toBe(true);
    expect(out.text).toMatch(/… \(truncated\)\n<\/memory>$/);
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(1024);
  });

  it("does not split Unicode and keeps a valid wrapper at byte boundaries", () => {
    const out = buildMemoryInjection(
      store([{ key: "pref.emoji", value: "😀".repeat(100) }]),
      "/p",
      55
    );
    expect(out.text.startsWith("<memory>\n")).toBe(true);
    expect(out.text.endsWith("</memory>")).toBe(true);
    expect(out.text).not.toContain("�");
    expect(Buffer.byteLength(out.text)).toBeLessThanOrEqual(55);
  });

  it("returns empty when the budget cannot fit a wrapper", () => {
    expect(
      buildMemoryInjection(store([{ key: "a", value: "b" }]), "/p", 10)
    ).toMatchObject({
      text: "",
      details: { truncated: true, facts: 0, lessons: 0 },
    });
  });

  it("returns empty without memories", () => {
    expect(buildMemoryInjection(store(), "/p").text).toBe("");
  });

  it("detects resumed injection and sends without triggering a turn", () => {
    const resumed = {
      sessionManager: {
        getBranch: vi.fn(() => [
          { type: "custom_message", customType: "context.memory" },
        ]),
      },
    } as any;
    expect(hasMemoryInjection(resumed)).toBe(true);

    const sendMessage = vi.fn();
    const ctx = { cwd: "/p", sessionManager: { getBranch: () => [] } } as any;
    expect(
      injectMemoryOnce(
        { sendMessage } as any,
        ctx,
        store([{ key: "a", value: "b" }])
      ).injected
    ).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith(expect.any(Object), {
      triggerTurn: false,
    });
  });
});
