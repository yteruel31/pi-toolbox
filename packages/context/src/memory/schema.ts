import { Schema } from "effect";

export const MEMORY_SCHEMA_VERSION = 1 as const;
export const MEMORY_CUSTOM_TYPE = "context.memory" as const;
export const MEMORY_MAX_INJECTION_BYTES = 8 * 1024;
export const MEMORY_MAX_EVENT_CHARS = 12_000;

export const ConsolidatedFactSchema = Schema.Struct({
  key: Schema.String,
  value: Schema.String,
  confidence: Schema.Number,
});
export const ConsolidatedLessonSchema = Schema.Struct({
  rule: Schema.String,
  category: Schema.String,
  negative: Schema.Boolean,
  confidence: Schema.Number,
});
export const ConsolidationOutputSchema = Schema.Struct({
  facts: Schema.Array(ConsolidatedFactSchema),
  lessons: Schema.Array(ConsolidatedLessonSchema),
});
export type ConsolidationOutput = typeof ConsolidationOutputSchema.Type;

export interface MemoryFact {
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export interface MemoryLesson {
  readonly id: string;
  readonly rule: string;
  readonly category: string;
  readonly negative: boolean;
  readonly confidence: number;
  readonly source: string;
  readonly project: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
}
export interface PendingEvent {
  readonly id: number;
  readonly sessionId: string;
  readonly project: string;
  readonly transcript: string;
  readonly userCount: number;
  readonly status: "pending" | "consolidated";
  readonly createdAt: string;
  readonly consolidatedAt: string | null;
}
