import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

import { LEARNING_STATE_ENTRY, type LearningState, type MutationSerializer } from "./contracts.js";
import {
	appendExtensionEvent,
	appendLearnerNote,
	createJournalState,
	ensureLearningWorkspace,
	listLearningJournals,
	resolveJournalForResume,
	workspacePathForJournal,
} from "./journal.js";
import {
	createLearningState,
	formatLearningStatus,
	hasActiveStateOutsideBranch,
	pauseLearningState,
	resumeLearningState,
	updateLearningState,
} from "./state.js";

const SUBCOMMANDS: AutocompleteItem[] = [
	{ value: "start", label: "start", description: "Start a new guided learning path" },
	{ value: "resume", label: "resume", description: "Resume from a journal under learning/" },
	{ value: "status", label: "status", description: "Show the active path and checkpoint" },
	{ value: "note", label: "note", description: "Append a learner note verbatim" },
	{ value: "off", label: "off", description: "Pause learning mode for this session" },
];

type CommandDependencies = {
	getState: () => LearningState | undefined;
	setState: (state: LearningState | undefined) => void;
	getCwd: () => string;
	updateStatus: (ctx: ExtensionCommandContext) => void;
	serialize: MutationSerializer;
};

function notifyError(ctx: ExtensionCommandContext, error: unknown): void {
	ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
}

function parseGoal(value: string): { topic?: string; outcome?: string } {
	const separator = value.indexOf("::");
	if (separator < 0) return { topic: value.trim() || undefined };
	return {
		topic: value.slice(0, separator).trim() || undefined,
		outcome: value.slice(separator + 2).trim() || undefined,
	};
}

function splitCommandArguments(args: string): { command: string; remainder: string; raw: string } {
	const raw = args.replace(/^\s+/, "");
	const separator = raw.search(/\s/);
	if (separator < 0) return { command: raw.toLowerCase(), remainder: "", raw };
	return {
		command: raw.slice(0, separator).toLowerCase(),
		remainder: raw.slice(separator + 1),
		raw,
	};
}

async function collectGoal(value: string, ctx: ExtensionCommandContext): Promise<{ topic: string; outcome: string } | undefined> {
	let { topic, outcome } = parseGoal(value);
	if ((!topic || !outcome) && !ctx.hasUI) {
		ctx.ui.notify("Usage: /learn start <topic> :: <concrete intended outcome>", "error");
		return undefined;
	}
	if (!topic) topic = (await ctx.ui.input("Technical topic:", "e.g. Rust ownership"))?.trim();
	if (!topic) return undefined;
	if (!outcome) {
		outcome = (await ctx.ui.input("Concrete intended outcome:", "e.g. build a small safe concurrent worker"))?.trim();
	}
	if (!outcome) return undefined;
	if (topic.length > 1_000) {
		ctx.ui.notify("The learning topic must be at most 1,000 characters.", "error");
		return undefined;
	}
	if (outcome.length > 2_000) {
		ctx.ui.notify("The intended outcome must be at most 2,000 characters.", "error");
		return undefined;
	}
	return { topic, outcome };
}

function hasOtherActivePath(ctx: ExtensionCommandContext): boolean {
	return hasActiveStateOutsideBranch(
		ctx.sessionManager.getEntries(),
		ctx.sessionManager.getBranch(),
		ctx.sessionManager.getSessionId(),
	);
}

function truncateDisplay(value: string, length = 240): string {
	return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function buildLearningArgumentCompletions(prefix: string, cwd: string): AutocompleteItem[] | null {
	const resumeMatch = prefix.match(/^\s*resume(?:\s+(.*))?$/i);
	if (resumeMatch && prefix.includes(" ")) {
		const journalPrefix = (resumeMatch[1] ?? "").trim().toLowerCase();
		const matches = listLearningJournals(cwd)
			.filter((path) => path.toLowerCase().startsWith(journalPrefix))
			.map((path) => ({ value: `resume ${path}`, label: path, description: "Resume this learning journal" }));
		return matches.length > 0 ? matches : null;
	}

	if (prefix.trim().includes(" ")) return null;
	const normalized = prefix.trim().toLowerCase();
	const matches = SUBCOMMANDS.filter((item) => item.value.startsWith(normalized));
	return matches.length > 0 ? matches : null;
}

export function registerLearningCommands(pi: ExtensionAPI, dependencies: CommandDependencies): void {
	const persist = (state: LearningState): void => {
		pi.appendEntry(LEARNING_STATE_ENTRY, state);
	};

	const activate = async (goalInput: string, ctx: ExtensionCommandContext): Promise<void> => {
		const goal = await collectGoal(goalInput, ctx);
		if (!goal) return;
		await ctx.waitForIdle();
		try {
			await dependencies.serialize(async () => {
				const current = dependencies.getState();
				if (current?.active) {
					ctx.ui.notify(`A learning path is already active: ${current.topic}`, "warning");
					return;
				}
				if (hasOtherActivePath(ctx)) {
					ctx.ui.notify("An active learning path exists on another session branch. Use /tree to return to it or resume its journal in a new session.", "warning");
					return;
				}

				const sessionId = ctx.sessionManager.getSessionId();
				const next = await createJournalState({
					sessionId,
					topic: goal.topic,
					outcome: goal.outcome,
					cwd: ctx.cwd,
					createState: (journalPath) =>
						createLearningState({ sessionId, topic: goal.topic, outcome: goal.outcome, cwd: ctx.cwd, journalPath }),
				});
				dependencies.setState(next);
				persist(next);
				dependencies.updateStatus(ctx);
				ctx.ui.notify(
					`Learning mode enabled. Workspace: ${workspacePathForJournal(next.journalPath)}/ · Journal: ${next.journalPath}`,
					"info",
				);
				pi.sendMessage(
					{
						customType: "pi-learning-command",
						content: "The learner explicitly activated learning mode. Begin now with the first short adaptive diagnostic question for the stated topic and outcome, then wait for the learner's answer.",
						display: true,
					},
					{ triggerTurn: true },
				);
			});
		} catch (error) {
			notifyError(ctx, error);
		}
	};

	pi.registerCommand("learn", {
		description: "Start or manage a pull-only technical learning path",
		getArgumentCompletions: (prefix) => buildLearningArgumentCompletions(prefix, dependencies.getCwd()),
		handler: async (args, ctx) => {
			const { command, remainder, raw } = splitCommandArguments(args);

			if (command === "status") {
				ctx.ui.notify(formatLearningStatus(dependencies.getState()), "info");
				return;
			}

			if (command === "off") {
				await ctx.waitForIdle();
				try {
					await dependencies.serialize(async () => {
						const current = dependencies.getState();
						if (!current?.active) {
							ctx.ui.notify("Learning mode is already inactive.", "info");
							return;
						}
						const next = pauseLearningState(current);
						await appendExtensionEvent(next, "Learning mode paused by the learner. The journal remains available for explicit resume.");
						dependencies.setState(next);
						persist(next);
						dependencies.updateStatus(ctx);
						ctx.ui.notify(`Learning mode paused. Journal: ${next.journalPath}`, "info");
					});
				} catch (error) {
					notifyError(ctx, error);
				}
				return;
			}

			if (command === "note") {
				let note = remainder;
				if (!note && ctx.hasUI) note = (await ctx.ui.editor("Learner note (stored verbatim):", "")) ?? "";
				if (!note) return;
				await ctx.waitForIdle();
				try {
					await dependencies.serialize(async () => {
						const current = dependencies.getState();
						if (!current?.active) throw new Error("Activate or resume learning mode before adding a learner note");
						const next = updateLearningState(current, {});
						await appendLearnerNote(next, note);
						dependencies.setState(next);
						persist(next);
						dependencies.updateStatus(ctx);
						ctx.ui.notify("Learner note appended verbatim.", "info");
					});
				} catch (error) {
					notifyError(ctx, error);
				}
				return;
			}

			if (command === "resume") {
				let requestedPath = remainder.trim();
				if (!requestedPath && ctx.hasUI) {
					const journals = listLearningJournals(ctx.cwd);
					requestedPath = (journals.length > 0 ? await ctx.ui.select("Resume learning journal:", journals) : undefined) ?? "";
				}
				if (!requestedPath) {
					ctx.ui.notify("Usage: /learn resume learning/<journal>.md", "error");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify("Journal resume requires an interactive confirmation because Markdown checkpoints are untrusted input.", "error");
					return;
				}

				try {
					const preview = await resolveJournalForResume(ctx.cwd, requestedPath);
					const confirmed = await ctx.ui.confirm(
						"Resume untrusted learning journal?",
						[
							`Topic: ${truncateDisplay(preview.state.topic)}`,
							`Outcome: ${truncateDisplay(preview.state.outcome)}`,
							`Phase: ${preview.state.phase}`,
							`Checkpoint preview (truncated to 240 characters if longer): ${truncateDisplay(preview.state.checkpoint)}`,
							"The journal is project-controlled Markdown. Its full checkpoint will be treated as untrusted data. Resume only if you trust its contents.",
						].join("\n"),
					);
					if (!confirmed) return;
					await ctx.waitForIdle();
					await dependencies.serialize(async () => {
						if (dependencies.getState()?.active) throw new Error("Pause the current path before resuming another journal");
						if (hasOtherActivePath(ctx)) throw new Error("Another learning path is active on a different session branch");
						const resolved = await resolveJournalForResume(ctx.cwd, requestedPath);
						if (JSON.stringify(resolved.state) !== JSON.stringify(preview.state)) {
							throw new Error("The journal checkpoint changed after confirmation; review it again before resuming");
						}
						if (resolved.state.phase === "complete") {
							ctx.ui.notify("This learning path is already complete. Start a new path with /learn start.", "info");
							return;
						}
						const next = resumeLearningState(resolved.state, {
							sessionId: ctx.sessionManager.getSessionId(),
							cwd: ctx.cwd,
							journalPath: resolved.relativePath,
						});
						const workspace = await ensureLearningWorkspace(next.cwd, next.journalPath);
						await appendExtensionEvent(
							next,
							`Learning journal explicitly resumed in a new Pi session. Learner workspace: \`${workspace.relativePath}/\`.`,
						);
						dependencies.setState(next);
						persist(next);
						dependencies.updateStatus(ctx);
						ctx.ui.notify(
							`Learning mode resumed. Workspace: ${workspace.relativePath}/ · Journal: ${next.journalPath}`,
							"info",
						);
						pi.sendMessage(
							{
								customType: "pi-learning-command",
								content: "The learner explicitly resumed a learner-approved but untrusted learning journal. Use only the bounded learning context supplied by the extension, ask one concise recovery question if needed, and wait.",
								display: true,
							},
							{ triggerTurn: true },
						);
					});
				} catch (error) {
					notifyError(ctx, error);
				}
				return;
			}

			if (command === "start") {
				await activate(remainder, ctx);
				return;
			}

			await activate(raw, ctx);
		},
	});
}
