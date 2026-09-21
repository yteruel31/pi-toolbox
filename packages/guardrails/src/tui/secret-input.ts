import { CURSOR_MARKER, decodeKittyPrintable, matchesKey, type Component, type Focusable } from "@earendil-works/pi-tui";

function modifiedPrintable(data: string): string | undefined {
  const match = /^\x1b\[27;(\d+);(\d+)~$/.exec(data);
  if (!match) return undefined;
  const modifier = Number(match[1]) - 1, codepoint = Number(match[2]);
  if (!Number.isSafeInteger(modifier) || modifier < 0 || (modifier & ~(1 | 64 | 128)) !== 0 || !Number.isSafeInteger(codepoint) || codepoint < 32 || codepoint > 0x10ffff) return undefined;
  return String.fromCodePoint(codepoint);
}

/** Masked input with no history, undo stack, kill ring, or clipboard writes. */
export class SecretInput implements Component, Focusable {
  focused = false;
  private value = "";
  private cursor = 0;
  private paste?: string;
  invalid = false;
  getValue(): string { return this.value; }
  clear(): void { this.value = ""; this.cursor = 0; this.paste = undefined; this.invalid = false; }
  consumePaste(data: string): boolean {
    if (this.paste === undefined) { if (!data.startsWith("\x1b[200~")) return false; this.paste = ""; data = data.slice(6); }
    const combined = this.paste + data, end = combined.indexOf("\x1b[201~");
    if (end >= 0) { this.insert(combined.slice(0, end)); this.paste = undefined; }
    else if (combined.length > 16_390) { this.invalid = true; this.paste = combined.slice(-5); }
    else this.paste = combined;
    return true;
  }
  private insert(text: string): void {
    if (/[^\x21-\x7e]/.test(text) || this.value.length + text.length > 16_384) { this.invalid = true; return; }
    this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor); this.cursor += text.length; this.invalid = false;
  }
  handleInput(data: string): void {
    if (this.consumePaste(data)) return;
    if (matchesKey(data, "ctrl+u")) this.clear();
    else if (matchesKey(data, "left")) this.cursor = Math.max(0, this.cursor - 1);
    else if (matchesKey(data, "right")) this.cursor = Math.min(this.value.length, this.cursor + 1);
    else if (matchesKey(data, "backspace") && this.cursor > 0) { this.value = this.value.slice(0, --this.cursor) + this.value.slice(this.cursor + 1); }
    else if (matchesKey(data, "delete")) this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1);
    else { const printable = decodeKittyPrintable(data) ?? modifiedPrintable(data); if (printable !== undefined) this.insert(printable); else if (/^[^\x00-\x1f\x7f-\x9f]+$/.test(data)) this.insert(data); }
  }
  render(width: number): string[] { width = Math.max(1, width); const before = "*".repeat(Math.min(this.cursor, width - 1)); return [`${before}${this.focused ? CURSOR_MARKER : ""}\x1b[7m*\x1b[27m`]; }
  invalidate(): void {}
  dispose(): void { this.clear(); }
}
