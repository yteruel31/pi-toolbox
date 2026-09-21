import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { SecretInput } from "../src/tui/secret-input.js";

describe("Jev SecretInput", () => {
  it("rejects an entire oversized chunked paste and never renders the key", () => {
    const input = new SecretInput(); input.focused = true;
    input.handleInput("kept"); input.handleInput("\x1b[200~" + "x".repeat(17_000)); input.handleInput("suffix\x1b[201~");
    expect(input.invalid).toBe(true); expect(input.getValue()).toBe("kept");
    for (const width of [1, 8, 40]) { const output = input.render(width); expect(output.every((line) => visibleWidth(line) <= width)).toBe(true); expect(output.join("")).not.toContain("kept"); }
  });

  it("rejects whitespace paste and clears all state on disposal", () => {
    const input = new SecretInput(); input.handleInput("old"); input.handleInput("\x1b[200~bad key\x1b[201~");
    expect(input.invalid).toBe(true); expect(input.getValue()).toBe("old"); input.dispose(); expect(input.getValue()).toBe(""); expect(input.invalid).toBe(false);
  });
});
