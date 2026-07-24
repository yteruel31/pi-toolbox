import {
	cloneLearningState,
	isLearningState,
	LEARNING_STATE_ENTRY,
	LEARNING_STATE_VERSION,
	LEARNING_TOOL_NAME,
	type HintMetrics,
	type JournalCheckpoint,
	type LearningState,
} from "./contracts.js";
import { workspacePathForJournal } from "./journal.js";

type SessionEntryLike = {
	id?: string;
	parentId?: string | null;
	type?: string;
	customType?: string;
	data?: unknown;
	message?: {
		role?: string;
		toolName?: string;
		details?: unknown;
	};
};

function stateCandidate(entry: SessionEntryLike): unknown | undefined {
	if (entry.type === "custom" && entry.customType === LEARNING_STATE_ENTRY) {
		return entry.data;
	}

	if (
		entry.type === "message" &&
		entry.message?.role === "toolResult" &&
		entry.message.toolName === LEARNING_TOOL_NAME &&
		entry.message.details &&
		typeof entry.message.details === "object"
	) {
		return (entry.message.details as { state?: unknown }).state;
	}

	return undefined;
}

export function restoreLearningState(entries: readonly SessionEntryLike[], sessionId: string): LearningState | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const candidate = stateCandidate(entries[index] as SessionEntryLike);
		if (candidate === undefined) continue;
		if (!isLearningState(candidate)) return undefined;
		if (candidate.sessionId !== sessionId) continue;
		return cloneLearningState(candidate);
	}
	return undefined;
}

export function hasActiveStateOutsideBranch(
	allEntries: readonly SessionEntryLike[],
	branchEntries: readonly SessionEntryLike[],
	sessionId: string,
): boolean {
	const byId = new Map(allEntries.filter((entry): entry is SessionEntryLike & { id: string } => Boolean(entry.id)).map((entry) => [entry.id, entry]));
	const parentIds = new Set(
		allEntries.map((entry) => entry.parentId).filter((parentId): parentId is string => typeof parentId === "string"),
	);
	const currentLeafId = [...branchEntries].reverse().find((entry) => entry.id)?.id;
	const leaves = [...byId.values()].filter((entry) => !parentIds.has(entry.id) && entry.id !== currentLeafId);

	return leaves.some((leaf) => {
		const path: SessionEntryLike[] = [];
		let entry: SessionEntryLike | undefined = leaf;
		const visited = new Set<string>();
		while (entry) {
			path.push(entry);
			if (!entry.parentId || visited.has(entry.parentId)) break;
			visited.add(entry.parentId);
			entry = byId.get(entry.parentId);
		}
		path.reverse();
		return restoreLearningState(path, sessionId)?.active === true;
	});
}

function validatedState(state: LearningState): LearningState {
	if (!isLearningState(state)) throw new Error("Learning state exceeds its supported limits or is invalid");
	return state;
}

export function createLearningState(input: {
	sessionId: string;
	topic: string;
	outcome: string;
	cwd: string;
	journalPath: string;
	now?: string;
}): LearningState {
	const now = input.now ?? new Date().toISOString();
	return validatedState({
		version: LEARNING_STATE_VERSION,
		sessionId: input.sessionId,
		active: true,
		topic: input.topic,
		outcome: input.outcome,
		cwd: input.cwd,
		journalPath: input.journalPath,
		phase: "diagnosis",
		checkpoint: "Learning path activated; adaptive diagnosis is next.",
		completedModules: 0,
		officialSourceCount: 0,
		roadmapChecked: false,
		currentHints: { maxLevel: 0, count: 0 },
		revision: 0,
		createdAt: now,
		updatedAt: now,
	});
}

export function updateLearningState(
	state: LearningState,
	patch: Partial<Omit<LearningState, "version" | "sessionId" | "createdAt" | "revision">>,
	now = new Date().toISOString(),
): LearningState {
	return validatedState({
		...cloneLearningState(state),
		...patch,
		currentHints: patch.currentHints ? { ...patch.currentHints } : { ...state.currentHints },
		baselineHints: patch.baselineHints
			? { ...patch.baselineHints }
			: patch.baselineHints === undefined
				? state.baselineHints
					? { ...state.baselineHints }
					: undefined
				: undefined,
		revision: state.revision + 1,
		updatedAt: now,
	});
}

export function pauseLearningState(state: LearningState, now?: string): LearningState {
	return updateLearningState(state, { active: false }, now);
}

export function resumeLearningState(
	stored: LearningState | JournalCheckpoint,
	input: { sessionId: string; cwd: string; journalPath: string; now?: string },
): LearningState {
	const now = input.now ?? new Date().toISOString();
	return validatedState({
		...stored,
		currentHints: { ...stored.currentHints },
		baselineHints: stored.baselineHints ? { ...stored.baselineHints } : undefined,
		sessionId: input.sessionId,
		cwd: input.cwd,
		journalPath: input.journalPath,
		active: true,
		revision: stored.revision + 1,
		updatedAt: now,
	});
}

export function isLessHelp(finalHints: HintMetrics, baselineHints: HintMetrics): boolean {
	if (finalHints.maxLevel === 0 && finalHints.count === 0 && baselineHints.maxLevel === 0 && baselineHints.count === 0) {
		return true;
	}
	return (
		finalHints.maxLevel <= baselineHints.maxLevel &&
		finalHints.count <= baselineHints.count &&
		(finalHints.maxLevel < baselineHints.maxLevel || finalHints.count < baselineHints.count)
	);
}

export function formatLearningStatus(state: LearningState | undefined): string {
	if (!state?.active) return "Learning mode is inactive.";
	const challenge = state.currentChallenge ? `\nChallenge: ${state.currentChallenge}` : "";
	return [
		`Learning mode: active`,
		`Topic: ${state.topic}`,
		`Outcome: ${state.outcome}`,
		`Phase: ${state.phase}`,
		`Completed modules: ${state.completedModules}`,
		`Journal: ${state.journalPath}`,
		`Workspace: ${workspacePathForJournal(state.journalPath)}/`,
		`Checkpoint: ${state.checkpoint}${challenge}`,
	].join("\n");
}
