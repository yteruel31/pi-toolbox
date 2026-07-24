import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerClaudeMarketplaceCommands } from "./commands/register.js";
import { discoverGeneratedAgentPaths } from "./components/agents.js";
import { discoverGeneratedSkillPaths } from "./components/skills.js";
import { runPreToolUseHooks } from "./hooks/runner.js";
import { registerClaudeMarketplaceAutocompleteDisplay } from "./session/autocomplete-display.js";
import { clearClaudeMarketplaceSummaryWidget, updateClaudeMarketplaceSessionSummary } from "./session/startup-summary.js";

export default function claudeMarketplaceExtension(pi: ExtensionAPI): void {
	registerClaudeMarketplaceCommands(pi);

	pi.on("resources_discover", async () => {
		const [skillPaths] = await Promise.all([discoverGeneratedSkillPaths(), discoverGeneratedAgentPaths()]);
		// Pi resource discovery currently has no agentPaths field; generated agents are
		// written into ~/.pi/agent/agents so pi-subagents can discover them normally.
		return { skillPaths };
	});

	pi.on("tool_call", runPreToolUseHooks);

	pi.on("session_start", (event, ctx) => {
		registerClaudeMarketplaceAutocompleteDisplay(ctx);
		updateClaudeMarketplaceSessionSummary(pi, event, ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearClaudeMarketplaceSummaryWidget(ctx);
	});
}
