import { CURSOR_MARKER, decodeKittyPrintable, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

/** Pi 0.84 exposes Kitty decoding but not its modifyOtherKeys printable helper. */
function modifyOtherKeysPrintable(data: string): string | undefined {
  const match = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
  if (!match) return undefined;
  const modifier = Number(match[1]) - 1;
  const codepoint = Number(match[2]);
  // Shift and lock flags only; Ctrl/Alt/Super remain shortcuts, never secret characters.
  if (!Number.isSafeInteger(modifier) || modifier < 0 || modifier > 193 || (modifier & ~(1 | 64 | 128)) !== 0 ||
    !Number.isSafeInteger(codepoint) || codepoint < 32 || codepoint > 0x10ffff) return undefined;
  return String.fromCodePoint(codepoint);
}

/** Deliberately no Input undo stack, kill ring, clipboard writes, or history. */
export class SecretInput implements Component, Focusable {
  focused = false;
  #value = "";
  #cursor = 0;
  #paste: string | undefined;
  #overflow = false;
  invalid = false;
  getValue(): string { return this.#value; }
  clear(): void { this.#value = ""; this.#cursor = 0; this.#paste = undefined; this.#overflow = false; this.invalid = false; }

  /** Consume bracketed paste before any navigation shortcuts, including chunked paste. */
  consumePaste(data: string): boolean {
    if (this.#paste === undefined) {
      if (!data.startsWith("\x1b[200~")) return false;
      this.#paste = "";
      data = data.slice(6);
    }
    const combined = this.#paste + data;
    const end = combined.indexOf("\x1b[201~");
    if (end >= 0) {
      if (!this.#overflow) this.insert(combined.slice(0, end));
      else this.invalid = true;
      this.#paste = undefined;
      this.#overflow = false;
    } else if (combined.length > 16_390) {
      // Retain only the delimiter tail while draining an oversized paste.
      this.#overflow = true;
      this.#paste = combined.slice(-5);
    } else this.#paste = combined;
    return true;
  }
  private insert(text: string): void {
    // Provider keys are printable ASCII tokens. Reject rather than silently alter pasted keys.
    if (/[^\x21-\x7e]/.test(text) || this.#value.length + text.length > 16_384) { this.invalid = true; return; }
    this.#value = this.#value.slice(0, this.#cursor) + text + this.#value.slice(this.#cursor);
    this.#cursor += text.length;
    this.invalid = false;
  }
  handleInput(data: string): void {
    if (this.consumePaste(data)) return;
    if (matchesKey(data, "ctrl+u")) this.clear();
    else if (matchesKey(data, "left")) this.#cursor = Math.max(0, this.#cursor - 1);
    else if (matchesKey(data, "right")) this.#cursor = Math.min(this.#value.length, this.#cursor + 1);
    else if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) this.#cursor = 0;
    else if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) this.#cursor = this.#value.length;
    else if (matchesKey(data, "backspace") && this.#cursor > 0) {
      this.#value = this.#value.slice(0, this.#cursor - 1) + this.#value.slice(this.#cursor);
      this.#cursor--; this.invalid = false;
    } else if (matchesKey(data, "delete")) {
      this.#value = this.#value.slice(0, this.#cursor) + this.#value.slice(this.#cursor + 1);
      this.invalid = false;
    } else {
      const printable = decodeKittyPrintable(data) ?? modifyOtherKeysPrintable(data);
      if (printable !== undefined) this.insert(printable);
      else if (/^[^\x00-\x1f\x7f-\x9f]+$/.test(data)) this.insert(data);
    }
  }
  render(width: number): string[] {
    width = Math.max(1, width);
    const start = Math.max(0, this.#cursor - width + 1);
    const before = "*".repeat(this.#cursor - start);
    const after = "*".repeat(Math.min(Math.max(0, this.#value.length - this.#cursor - 1), Math.max(0, width - before.length - 1)));
    return [`${before}${this.focused ? CURSOR_MARKER : ""}\x1b[7m${this.#cursor < this.#value.length ? "*" : " "}\x1b[27m${after}`];
  }
  invalidate(): void {}
  dispose(): void { this.clear(); }
}
