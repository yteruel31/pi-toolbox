import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { appendAiRecord, type AiJournalCategory, type AiJournalRecord } from "./journal.js";
import { type LearningPhase, type LearningState, type MutationSerializer } from "./contracts.js";
import { isLessHelp, updateLearningState } from "./state.js";

const ACTIONS = ["append", "checkpoint", "record_hint", "record_mastery", "complete"] as const;
const CATEGORIES = ["diagnosis", "source", "path", "challenge", "hint", "synthesis", "correction", "mastery", "final", "checkpoint"] as const;
const PHASES = ["diagnosis", "path", "challenge", "final"] as const;
const SOURCE_CLASSES = ["official-primary", "secondary"] as const;

const LearningJournalParams = Type.Object({
	action: StringEnum(ACTIONS),
	content: Type.String({ description: "Concise Markdown content to append to the AI-authored journal record", maxLength: 10_000 }),
	category: Type.Optional(StringEnum(CATEGORIES)),
	title: Type.Optional(Type.String({ maxLength: 500 })),
	phase: Type.Optional(StringEnum(PHASES)),
	currentChallenge: Type.Optional(Type.String({ maxLength: 2_000 })),
	hintLevel: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
	sourceUrl: Type.Optional(Type.String({ maxLength: 2_048 })),
	sourceClass: Type.Optional(StringEnum(SOURCE_CLASSES)),
	artifactEvidence: Type.Optional(Type.String({ maxLength: 10_000 })),
	learnerExplanation: Type.Optional(Type.String({ maxLength: 10_000 })),
	outcomeEvidence: Type.Optional(Type.String({ maxLength: 10_000 })),
	finalChallengeEvidence: Type.Optional(Type.String({ maxLength: 10_000 })),
});

export type LearningJournalInput = Static<typeof LearningJournalParams>;

function required(value: string | undefined, field: string): string {
	if (!value?.trim()) throw new Error(`${field} is required for this action`);
	return value;
}

function validatedSourceUrl(value: string | undefined): URL {
	const sourceUrl = required(value, "sourceUrl");
	let parsed: URL;
	try {
		parsed = new URL(sourceUrl);
	} catch {
		throw new Error("sourceUrl must be a valid HTTP(S) URL");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("sourceUrl must use HTTP or HTTPS");
	}
	if (parsed.username || parsed.password) throw new Error("sourceUrl must not contain embedded credentials");
	for (const key of parsed.searchParams.keys()) {
		if (/(?:token|secret|password|credential|signature|api[-_]?key|auth)/i.test(key)) {
			throw new Error(`sourceUrl must not contain sensitive query parameter: ${key}`);
		}
	}
	return parsed;
}

function recordFor(params: LearningJournalInput, category: AiJournalCategory): AiJournalRecord {
	return {
		category,
		content: params.content,
		title: params.title,
		sourceUrl: category === "source" ? params.sourceUrl : undefined,
		sourceClass: category === "source" ? params.sourceClass : undefined,
	};
}

export function registerLearningJournalTool(
	pi: ExtensionAPI,
	getState: () => LearningState | undefined,
	setState: (state: LearningState) => void,
	serialize: MutationSerializer,
): void {
	pi.registerTool({
		name: "learning_journal",
		label: "Learning Journal",
		description: "Append AI-authored learning records and advance the active pi-learning checkpoint. Cannot create learner notes or choose a file path.",
		promptSnippet: "Append AI synthesis, sources, hints, mastery evidence, and checkpoints to the active learning journal",
		promptGuidelines: [
			"Use learning_journal only while pi-learning mode is active; learner-authored notes must be added with /learn note.",
		],
		parameters: LearningJournalParams,
		async execute(_toolCallId, params) {
			return serialize(async () => {
				const state = getState();
			if (!state?.active) throw new Error("pi-learning mode is not active");
			required(params.content, "content");

			let next: LearningState;
			let record: AiJournalRecord;

			switch (params.action) {
				case "append": {
					const category = required(params.category, "category") as AiJournalCategory;
					if (category === "source") {
						const sourceUrl = validatedSourceUrl(params.sourceUrl);
						params.sourceUrl = sourceUrl.toString();
						const sourceClass = required(params.sourceClass, "sourceClass");
						const isRoadmap = sourceUrl.hostname === "roadmap.sh" || sourceUrl.hostname.endsWith(".roadmap.sh");
						if (isRoadmap && sourceClass !== "secondary") {
							throw new Error("roadmap.sh must be recorded as a secondary source");
						}
						next = updateLearningState(state, {
							officialSourceCount: state.officialSourceCount + (sourceClass === "official-primary" && !isRoadmap ? 1 : 0),
							roadmapChecked: state.roadmapChecked || isRoadmap,
						});
					} else {
						next = updateLearningState(state, {});
					}
					record = recordFor(params, category);
					break;
				}
				case "checkpoint": {
					const phase = required(params.phase, "phase") as LearningPhase;
					if (phase !== "diagnosis" && (state.officialSourceCount < 1 || !state.roadmapChecked)) {
						throw new Error("Record at least one official/primary source and a roadmap.sh check before designing the path");
					}
					if ((phase === "challenge" || phase === "final") && !params.currentChallenge?.trim()) {
						throw new Error("currentChallenge is required when entering a challenge phase");
					}
					const startsNewChallenge =
						(phase === "challenge" || phase === "final") &&
						(state.phase !== phase || state.currentChallenge !== params.currentChallenge);
					next = updateLearningState(state, {
						phase,
						checkpoint: params.content,
						currentChallenge: params.currentChallenge,
						currentHints: startsNewChallenge ? { maxLevel: 0, count: 0 } : state.currentHints,
					});
					record = recordFor(params, "checkpoint");
					break;
				}
				case "record_hint": {
					if (!state.currentChallenge || (state.phase !== "challenge" && state.phase !== "final")) {
						throw new Error("A current challenge is required before recording a hint");
					}
					const hintLevel = params.hintLevel;
					if (hintLevel === undefined) throw new Error("hintLevel is required for record_hint");
					if (hintLevel < state.currentHints.maxLevel) {
						throw new Error("Hint levels cannot move backwards within a challenge");
					}
					next = updateLearningState(state, {
						checkpoint: params.content,
						currentHints: {
							maxLevel: Math.max(state.currentHints.maxLevel, hintLevel),
							count: state.currentHints.count + 1,
						},
					});
					record = recordFor(params, "hint");
					break;
				}
				case "record_mastery": {
					if (state.phase !== "challenge" || !state.currentChallenge) {
						throw new Error("Module mastery can only be recorded for the current module challenge");
					}
					const artifact = required(params.artifactEvidence, "artifactEvidence");
					const explanation = required(params.learnerExplanation, "learnerExplanation");
					next = updateLearningState(state, {
						phase: "path",
						checkpoint: params.content,
						completedModules: state.completedModules + 1,
						baselineHints: state.baselineHints ?? state.currentHints,
						currentChallenge: undefined,
						currentHints: { maxLevel: 0, count: 0 },
					});
					record = recordFor(
						{ ...params, content: `${params.content}\n\n**Artifact evidence:** ${artifact}\n\n**Learner explanation evidence:** ${explanation}` },
						"mastery",
					);
					break;
				}
				case "complete": {
					if (state.phase !== "final" || !state.currentChallenge) {
						throw new Error("Completion requires an active final transfer challenge");
					}
					if (state.completedModules < 1 || !state.baselineHints) {
						throw new Error("Completion requires at least one mastered module and a help baseline");
					}
					const outcome = required(params.outcomeEvidence, "outcomeEvidence");
					const explanation = required(params.learnerExplanation, "learnerExplanation");
					const finalChallenge = required(params.finalChallengeEvidence, "finalChallengeEvidence");
					if (!isLessHelp(state.currentHints, state.baselineHints)) {
						throw new Error("The final transfer challenge has not yet used less help than the first mastered module");
					}
					next = updateLearningState(state, {
						active: false,
						phase: "complete",
						checkpoint: params.content,
					});
					record = recordFor(
						{
							...params,
							content: `${params.content}\n\n**Outcome evidence:** ${outcome}\n\n**Learner explanation evidence:** ${explanation}\n\n**Novel transfer challenge evidence:** ${finalChallenge}`,
						},
						"final",
					);
					break;
				}
			}

			await appendAiRecord(next, record);
			setState(next);
				return {
					content: [{ type: "text", text: `Recorded ${params.action} in ${next.journalPath}` }],
					details: { action: params.action, state: next, journalPath: next.journalPath },
				};
			});
		},
	});
}
