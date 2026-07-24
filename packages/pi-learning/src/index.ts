import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { registerLearningCommands } from "./commands.js";
import { LEARNING_TOOL_NAME, type LearningState } from "./contracts.js";
import { registerLearningJournalTool } from "./journal-tool.js";
import { ensureLearningWorkspace } from "./journal.js";
import { restoreLearningState } from "./state.js";
import { buildTutorPrompt } from "./tutor-prompt.js";

const STATUS_KEY = "pi-learning";

export default function learningExtension(pi: ExtensionAPI): void {
	let state: LearningState | undefined;
	let cwd = process.cwd();
	let mutationQueue: Promise<void> = Promise.resolve();
	const serialize = <T>(work: () => Promise<T>): Promise<T> => {
		const result = mutationQueue.then(work, work);
		mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const updateStatus = (ctx: ExtensionContext): void => {
		if (!state?.active) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const progress = state.phase === "challenge" || state.phase === "final" ? ` · ${state.completedModules} mastered` : "";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("accent", `learn: ${state.phase}${progress}`));
	};

	const reconstruct = async (ctx: ExtensionContext): Promise<void> => {
		cwd = ctx.cwd;
		state = restoreLearningState(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
		if (state?.active) {
			try {
				await ensureLearningWorkspace(state.cwd, state.journalPath);
			} catch (error) {
				ctx.ui.notify(
					`Learning workspace unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		}
		updateStatus(ctx);
	};

	registerLearningJournalTool(
		pi,
		() => state,
		(next) => {
			state = next;
		},
		serialize,
	);

	registerLearningCommands(pi, {
		getState: () => state,
		setState: (next) => {
			state = next;
		},
		getCwd: () => cwd,
		updateStatus,
		serialize,
	});

	pi.on("session_start", async (_event, ctx) => {
		await reconstruct(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		await reconstruct(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		if (!state?.active) return;
		const activeTools = event.systemPromptOptions.selectedTools ?? pi.getActiveTools();
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildTutorPrompt(state, activeTools)}`,
		};
	});

	pi.on("tool_call", async (event) => {
		if (!state?.active || (event.toolName !== "write" && event.toolName !== "edit")) return;
		return {
			block: true,
			reason: "pi-learning mode: the tutor evaluates but does not modify the learner's solution. Provide a hint, explanation, or verification instead, or use /learn off.",
		};
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName === LEARNING_TOOL_NAME) updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
