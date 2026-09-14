export interface Block { block: true; reason: string; terminate?: boolean }
export interface PiChildAssessment {
  assess(event: { toolName: string; toolCallId: string; input: Record<string, unknown>; childSessionId: string }): Promise<Block | undefined>;
  result(event: { toolCallId: string; childSessionId: string; isError: boolean }): void;
}
export interface PiChildAssessmentRequest {
  v: 1;
  parentSessionId: string;
  runId: string;
  profile?: string;
  cwd: string;
  signal: AbortSignal;
  /** Providers register synchronously on the parent event bus. */
  provide(gate: PiChildAssessment): void;
}
