export const LEARNING_STATE_ENTRY = "pi-learning-state/v1";
export const LEARNING_TOOL_NAME = "learning_journal";
export const LEARNING_DIRECTORY = "learning";
export const LEARNING_STATE_VERSION = 1 as const;

export type LearningPhase = "diagnosis" | "path" | "challenge" | "final" | "complete" | "paused";

export type HintMetrics = {
	maxLevel: number;
	count: number;
};

export type LearningState = {
	version: typeof LEARNING_STATE_VERSION;
	sessionId: string;
	active: boolean;
	topic: string;
	outcome: string;
	cwd: string;
	journalPath: string;
	phase: LearningPhase;
	currentChallenge?: string;
	checkpoint: string;
	completedModules: number;
	officialSourceCount: number;
	roadmapChecked: boolean;
	currentHints: HintMetrics;
	baselineHints?: HintMetrics;
	revision: number;
	createdAt: string;
	updatedAt: string;
};

export type JournalCheckpoint = Omit<LearningState, "sessionId" | "cwd" | "journalPath">;

export type MutationSerializer = <T>(work: () => Promise<T>) => Promise<T>;

export type LearningToolDetails = {
	action: string;
	state: LearningState;
	journalPath: string;
};

const PHASES = new Set<LearningPhase>(["diagnosis", "path", "challenge", "final", "complete", "paused"]);

function isHintMetrics(value: unknown): value is HintMetrics {
	if (!value || typeof value !== "object") return false;
	const metrics = value as Record<string, unknown>;
	return (
		typeof metrics.maxLevel === "number" &&
		Number.isInteger(metrics.maxLevel) &&
		metrics.maxLevel >= 0 &&
		metrics.maxLevel <= 4 &&
		typeof metrics.count === "number" &&
		Number.isInteger(metrics.count) &&
		metrics.count >= 0
	);
}

export function isLearningState(value: unknown): value is LearningState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	return (
		state.version === LEARNING_STATE_VERSION &&
		typeof state.sessionId === "string" &&
		state.sessionId.length > 0 &&
		typeof state.active === "boolean" &&
		typeof state.topic === "string" &&
		state.topic.length > 0 &&
		state.topic.length <= 1_000 &&
		typeof state.outcome === "string" &&
		state.outcome.length > 0 &&
		state.outcome.length <= 2_000 &&
		typeof state.cwd === "string" &&
		state.cwd.length > 0 &&
		state.cwd.length <= 4_096 &&
		typeof state.journalPath === "string" &&
		state.journalPath.length > 0 &&
		state.journalPath.length <= 4_096 &&
		typeof state.phase === "string" &&
		PHASES.has(state.phase as LearningPhase) &&
		(state.currentChallenge === undefined ||
			(typeof state.currentChallenge === "string" && state.currentChallenge.length <= 2_000)) &&
		typeof state.checkpoint === "string" &&
		state.checkpoint.length <= 10_000 &&
		typeof state.completedModules === "number" &&
		Number.isInteger(state.completedModules) &&
		state.completedModules >= 0 &&
		typeof state.officialSourceCount === "number" &&
		Number.isInteger(state.officialSourceCount) &&
		state.officialSourceCount >= 0 &&
		typeof state.roadmapChecked === "boolean" &&
		isHintMetrics(state.currentHints) &&
		(state.baselineHints === undefined || isHintMetrics(state.baselineHints)) &&
		typeof state.revision === "number" &&
		Number.isInteger(state.revision) &&
		state.revision >= 0 &&
		typeof state.createdAt === "string" &&
		state.createdAt.length <= 64 &&
		typeof state.updatedAt === "string" &&
		state.updatedAt.length <= 64
	);
}

export function parseJournalCheckpoint(value: unknown): JournalCheckpoint | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const checkpoint = {
		version: raw.version,
		active: raw.active,
		topic: raw.topic,
		outcome: raw.outcome,
		phase: raw.phase,
		currentChallenge: raw.currentChallenge,
		checkpoint: raw.checkpoint,
		completedModules: raw.completedModules,
		officialSourceCount: raw.officialSourceCount,
		roadmapChecked: raw.roadmapChecked,
		currentHints: raw.currentHints,
		baselineHints: raw.baselineHints,
		revision: raw.revision,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
	};
	if (
		!isLearningState({
			...checkpoint,
			sessionId: "portable-journal",
			cwd: ".",
			journalPath: "learning/journal.md",
		})
	) {
		return undefined;
	}
	return checkpoint as JournalCheckpoint;
}

export function cloneLearningState(state: LearningState): LearningState {
	return {
		...state,
		currentHints: { ...state.currentHints },
		baselineHints: state.baselineHints ? { ...state.baselineHints } : undefined,
	};
}
