export const PI_MAX_BYTES = 50 * 1024;
export const PI_MAX_LINES = 2_000;
export const estimateTokens = (text: string): number => Math.ceil([...text].length / 4);

export function boundText(text: string, maxBytes = PI_MAX_BYTES, maxLines = PI_MAX_LINES, suffix = "\n… [truncated]"): string {
  const lines = text.split("\n").slice(0, maxLines);
  let candidate = lines.join("\n");
  if (lines.length === text.split("\n").length && Buffer.byteLength(candidate) <= maxBytes) return candidate;
  const suffixBytes = Buffer.byteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);
  let bytes = 0;
  let output = "";
  for (const point of candidate) {
    const size = Buffer.byteLength(point);
    if (bytes + size > budget) break;
    output += point;
    bytes += size;
  }
  return output.replace(/\n+$/, "") + suffix;
}
