import type { LedgerEntry } from "./ledger/types.js";
import { boundText, PI_MAX_BYTES, PI_MAX_LINES } from "./tokens.js";

const HIDDEN_PREFIXES = ["context.memory", "context.session", "context.knowledge"];
const textBlocks = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.flatMap((block: any) => block?.type === "text" && typeof block.text === "string" ? [block.text] : block?.type === "toolCall" && typeof block.name === "string" ? [`[tool call ${block.name}: ${JSON.stringify(block.arguments ?? {})}]`] : []).join("\n") : "";
export function isHiddenContextEntry(entry: LedgerEntry): boolean {
  const customType = "customType" in entry && typeof entry.customType === "string" ? entry.customType : "";
  return HIDDEN_PREFIXES.some((prefix) => customType === prefix || customType.startsWith(`${prefix}-`) || customType.startsWith(`${prefix}.`));
}
export function serializeSourceEntry(entry: LedgerEntry): string | undefined {
  if (isHiddenContextEntry(entry)) return undefined;
  if (entry.type === "message" && "message" in entry && entry.message && typeof entry.message === "object") {
    const message = entry.message as any;
    const label = message.role === "toolResult" ? `Tool ${message.toolName ?? "result"}` : message.role === "assistant" ? "Assistant" : message.role === "user" ? "User" : undefined;
    if (!label) return undefined;
    const text = textBlocks(message.content);
    return text ? `[${entry.id}] ${label}: ${text}` : undefined;
  }
  if (entry.type === "custom_message") {
    const text = textBlocks((entry as any).content);
    return text ? `[${entry.id}] Custom: ${text}` : undefined;
  }
  if (entry.type === "branch_summary" && typeof (entry as any).summary === "string") return `[${entry.id}] Branch summary: ${(entry as any).summary}`;
  return undefined;
}
export function serializeSourceEntries(entries: readonly LedgerEntry[], maxBytes = PI_MAX_BYTES, maxLines = PI_MAX_LINES): string {
  return boundText(entries.flatMap((entry) => { const text = serializeSourceEntry(entry); return text ? [text] : []; }).join("\n\n"), maxBytes, maxLines);
}
