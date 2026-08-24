import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { recall } from "./recall.js";
import type { LedgerEntry } from "./ledger/types.js";

export function registerObservationalTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "recall",
    label: "Recall memory evidence",
    description: "Resolve one exact 12-character lowercase hexadecimal active observational-memory ID on the current branch. This is not semantic search.",
    parameters: Type.Object({ id: Type.String({ pattern: "^[a-f0-9]{12}$" }) }, { additionalProperties: false }),
    async execute(_callId, params, _signal, _update, ctx) {
      const result = recall(ctx.sessionManager.getBranch() as LedgerEntry[], params.id);
      return { content: [{ type: "text", text: result.text }], details: result.details };
    },
  });
}
