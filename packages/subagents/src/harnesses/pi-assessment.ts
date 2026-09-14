import type { Block } from "./pi-assessment-types.js";
export type { Block, PiChildAssessment, PiChildAssessmentRequest } from "./pi-assessment-types.js";
import type { PiChildAssessment, PiChildAssessmentRequest } from "./pi-assessment-types.js";

/** Optional parent-only protocol. Children receive callbacks, never the parent's event bus. */
export const PI_CHILD_ASSESSMENT_CHANNEL = "pi-toolbox:guardrails:pi-child:v1";
export interface AssessmentBus { emit(channel: string, data: unknown): void }
export function requestPiChildAssessment(bus: AssessmentBus | undefined, request: Omit<PiChildAssessmentRequest, "provide" | "v">): PiChildAssessment | undefined {
  const providers: PiChildAssessment[] = [];
  bus?.emit(PI_CHILD_ASSESSMENT_CHANNEL, { ...request, v: 1, provide: (gate: PiChildAssessment) => providers.push(gate) } satisfies PiChildAssessmentRequest);
  if (!providers.length) return undefined;
  return {
    async assess(event) {
      for (const provider of providers) {
        try {
          const block = await provider.assess(event);
          if (block) return block;
        } catch { return { block: true, reason: "Parent tool assessment failed. Try a safe alternative or report the blocker." } satisfies Block; }
      }
      return undefined;
    },
    result(event) { for (const provider of providers) { try { provider.result(event); } catch { /* Decision reporting doesn't change execution. */ } } },
  };
}
