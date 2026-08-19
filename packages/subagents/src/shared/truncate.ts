/**
 * Text bounding helpers. Every model-visible string in this package goes
 * through one of these before leaving the core.
 */

const MARKER_PREFIX = "… [truncated ";
const MARKER_SUFFIX = " chars]";
const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const ESCAPE_CHARACTER = /\u001b/g;

/**
 * Bound `text` to at most `maxChars` characters, appending a marker that
 * states how many characters were dropped. The returned string, marker
 * included, never exceeds `maxChars` (unless `maxChars` is too small to fit
 * any marker, in which case it is a plain slice).
 */
export function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  // Reserve room for the marker. The dropped count can change the marker
  // length, so shrink `keep` until the whole thing fits.
  const markerFor = (keep: number) =>
    `${MARKER_PREFIX}${text.length - keep}${MARKER_SUFFIX}`;
  let keep = Math.max(0, maxChars - markerFor(maxChars).length);
  while (keep > 0 && keep + markerFor(keep).length > maxChars) keep--;
  if (keep <= 0) return text.slice(0, maxChars);
  return text.slice(0, keep) + markerFor(keep);
}

/**
 * Remove terminal-control characters while retaining newlines and tabs as
 * plain content. Removing ESC itself makes any remaining sequence inert.
 */
export function sanitizeTerminalText(text: string): string {
  return text
    .replace(ESCAPE_CHARACTER, "")
    .replace(UNSAFE_CONTROL_CHARACTERS, "");
}

/** Collapse whitespace and bound a string for one-line display titles. */
export function toDisplayTitle(text: string, maxChars = 60): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return truncateText(collapsed, maxChars);
}
