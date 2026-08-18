import { describe, expect, it } from "vitest";

import { ClaudeHarness } from "../src/harnesses/claude.js";
import { makeRequest } from "./helpers/fake-claude-sdk.js";

const LIVE = process.env.PI_SUBAGENTS_CLAUDE_LIVE === "1";

describe.skipIf(!LIVE)("claude harness live", () => {
  it(
    "runs one authenticated headless query through the installed SDK",
    async () => {
      const harness = new ClaudeHarness();
      const { request, effectiveModels } = makeRequest({
        prompt:
          "Reply with a single short sentence confirming that the live Claude harness works. Do not use tools.",
        systemPrompt: "Keep the answer short and do not use tools.",
        workingDir: process.cwd(),
        model: process.env.PI_SUBAGENTS_CLAUDE_LIVE_MODEL ?? "haiku",
        thinkingLevel: "off",
      });

      const outcome = await harness.run(request);

      expect(outcome.finalText.trim().length).toBeGreaterThan(0);
      expect(outcome.effectiveModel).toBe(effectiveModels.at(-1));
      expect(outcome.usage?.input).toBeGreaterThanOrEqual(0);
      expect(outcome.usage?.output).toBeGreaterThan(0);
    },
    180_000,
  );
});
