import type { DeliveryContent } from "@yteruel31/pi-operation-hooks";
import { sanitize } from "./sanitize.js";

export const INCOMING_MAX_BYTES = 256_000;
export type IncomingAssessment = "clean" | "suspicious" | "incomplete";
export interface IncomingEvidence { assessment: IncomingAssessment; evidence: string[]; incomplete: boolean }

const activePatterns = [
  /(?:^|[\r\n])\s*(?:system|assistant|developer|tool)\s*:/gi,
  /\bignore\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions?\b/gi,
  /\b(?:follow|execute|obey)\s+(?:these|the following|my)\s+instructions?\b/gi,
  /\b(?:reveal|exfiltrate|send|upload|print|return)\b[^\r\n]{0,120}\b(?:secret|credential|token|password|private[ -]?key)\b/gi,
  /<\/?(?:system|assistant|developer|tool|prompt|instructions?)\b/gi,
  /\b(?:call|invoke|use|run)\s+(?:the\s+)?(?:tool|function|command)\b/gi,
];
const contextPattern = /\b(?:example|sample|quote|quotation|documentation|docs?|article|explains?|describes?|discusses?|detects?|phrase|string|pattern|regex|attack|prompt injection|security training|says?|wrote)\b/i;
interface Budget { nodes: number; bytes: number }

function collect(value: unknown, parts: string[], seen: Set<object>, budget: Budget, depth = 0): boolean {
  if (++budget.nodes > 4096 || depth > 12) return false;
  if (value === null || value === undefined || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return true;
  if (typeof value === "string") {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > INCOMING_MAX_BYTES) return false;
    parts.push(value); return true;
  }
  if (typeof value !== "object" || seen.has(value) || value instanceof Map || value instanceof Set || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) return false;
  seen.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 4096) return false;
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return false;
    budget.bytes += Buffer.byteLength(key);
    if (budget.bytes > INCOMING_MAX_BYTES || ((key === "data" || key === "bytes") && typeof descriptor.value === "string")) return false;
    if (!collect(key, parts, seen, budget, depth + 1) || !collect(descriptor.value, parts, seen, budget, depth + 1)) return false;
  }
  seen.delete(value); return true;
}

function quotedSpan(text: string, start: number, end: number): boolean {
  const openers: Array<[string, string]> = [["`", "`"], ["\"", "\""], ["'", "'"], ["“", "”"]];
  for (const [open, close] of openers) {
    const before = text.lastIndexOf(open, start);
    if (before < 0) continue;
    const precedingClose = text.lastIndexOf(close, start - 1);
    if (precedingClose > before && !(open === close && precedingClose === before)) continue;
    const after = text.indexOf(close, end);
    if (after < 0) continue;
    const context = text.slice(Math.max(0, before - 180), before);
    if (contextPattern.test(context)) return true;
  }
  return false;
}

export function incomingEvidence(delivery: DeliveryContent): IncomingEvidence {
  const parts: string[] = [];
  const collected = collect(delivery, parts, new Set(), { nodes: 0, bytes: 0 });
  let incomplete = !collected;
  const safeParts: string[] = [];
  let safeBytes = 0;
  for (const part of parts) {
    const segments = part.split(/(\r\n|\r|\n|\t)/);
    let safe = "";
    for (const segment of segments) {
      if (/^(?:\r\n|\r|\n|\t)$/.test(segment)) { safe += segment; continue; }
      const sanitized = sanitize(segment, INCOMING_MAX_BYTES);
      if (sanitized !== segment) incomplete = true;
      safe += sanitized;
    }
    const bytes = Buffer.byteLength(safe);
    if (safeBytes + bytes > INCOMING_MAX_BYTES) { incomplete = true; break; }
    safeParts.push(safe); safeBytes += bytes;
  }
  const text = safeParts.join("\n");
  let suspicious = false;
  for (const pattern of activePatterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index;
      if (!quotedSpan(text, index, index + match[0].length)) suspicious = true;
    }
  }
  return { assessment: suspicious ? "suspicious" : incomplete ? "incomplete" : "clean", evidence: text ? [text] : [], incomplete };
}

/** Conservative deterministic fallback. Clean means only that no active pattern was found. */
export function assessIncomingDelivery(delivery: DeliveryContent): IncomingAssessment { return incomingEvidence(delivery).assessment; }
