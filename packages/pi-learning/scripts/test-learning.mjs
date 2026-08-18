import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const tmpRoot = await mkdtemp(join(tmpdir(), "pi-learning-"));
const buildDir = join(tmpRoot, "build");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

try {
	await symlink(join(repoRoot, "node_modules"), join(tmpRoot, "node_modules"), "dir");
	execFileSync(
		process.execPath,
		[
			join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
			"-p",
			join(packageRoot, "tsconfig.json"),
			"--outDir",
			buildDir,
			"--noEmit",
			"false",
		],
		{ cwd: packageRoot, stdio: "inherit" },
	);

	const contracts = await import(pathToFileURL(join(buildDir, "contracts.js")));
	const stateModule = await import(pathToFileURL(join(buildDir, "state.js")));
	const journal = await import(pathToFileURL(join(buildDir, "journal.js")));
	const promptModule = await import(pathToFileURL(join(buildDir, "tutor-prompt.js")));
	const commandsModule = await import(pathToFileURL(join(buildDir, "commands.js")));
	const extensionModule = await import(pathToFileURL(join(buildDir, "index.js")));

	const now = "2026-07-23T12:00:00.000Z";
	const initial = stateModule.createLearningState({
		sessionId: "session-one",
		topic: "Rust ownership",
		outcome: "Build a safe concurrent worker",
		cwd: tmpRoot,
		journalPath: "learning/session-one-rust-ownership.md",
		now,
	});
	assert(contracts.isLearningState(initial), "created state should validate");
	let oversizedStateRejected = false;
	try {
		stateModule.createLearningState({ ...initial, topic: "x".repeat(1_001) });
	} catch {
		oversizedStateRejected = true;
	}
	assert(oversizedStateRejected, "state creation should reject oversized fields");
	assertEqual(stateModule.restoreLearningState([
		{ id: "1", type: "custom", customType: contracts.LEARNING_STATE_ENTRY, data: initial },
	], "session-one").topic, "Rust ownership", "branch state should restore");
	assertEqual(stateModule.restoreLearningState([
		{ id: "1", type: "custom", customType: contracts.LEARNING_STATE_ENTRY, data: initial },
		{ id: "2", type: "custom", customType: contracts.LEARNING_STATE_ENTRY, data: { version: 1 } },
	], "session-one"), undefined, "malformed latest state should fail closed");
	assert(stateModule.hasActiveStateOutsideBranch([
		{ id: "1", parentId: null, type: "custom", customType: contracts.LEARNING_STATE_ENTRY, data: initial },
	], [], "session-one"), "off-branch active track should be detected");
	const pausedForBranch = stateModule.pauseLearningState(initial, "2026-07-23T12:00:30.000Z");
	assert(!stateModule.hasActiveStateOutsideBranch([
		{ id: "root", parentId: null, type: "message" },
		{ id: "active", parentId: "root", type: "custom", customType: contracts.LEARNING_STATE_ENTRY, data: initial },
		{ id: "paused", parentId: "active", type: "custom", customType: contracts.LEARNING_STATE_ENTRY, data: pausedForBranch },
		{ id: "current", parentId: "root", type: "message" },
	], [{ id: "root", parentId: null }, { id: "current", parentId: "root" }], "session-one"), "a latest paused sibling branch should not block a new path");
	assertEqual(pausedForBranch.phase, initial.phase, "pause should preserve the operational phase");
	assertEqual(stateModule.resumeLearningState(pausedForBranch, { sessionId: "session-two", cwd: tmpRoot, journalPath: initial.journalPath, now }).checkpoint, initial.checkpoint, "resume should preserve the checkpoint");
	assert(stateModule.isLessHelp({ maxLevel: 1, count: 1 }, { maxLevel: 2, count: 1 }), "lower hint level should be less help");
	assert(!stateModule.isLessHelp({ maxLevel: 2, count: 1 }, { maxLevel: 2, count: 1 }), "equal non-zero help should not pass");
	assert(stateModule.isLessHelp({ maxLevel: 0, count: 0 }, { maxLevel: 0, count: 0 }), "zero-help baseline and final should pass");
	assert(!stateModule.isLessHelp({ maxLevel: 1, count: 100 }, { maxLevel: 2, count: 1 }), "many lower-level hints should not count as less help");

	await journal.initializeJournal(initial);
	assertEqual(
		journal.workspacePathForJournal(initial.journalPath),
		"learning/session-one-rust-ownership",
		"workspace path should derive from the journal name",
	);
	const workspaceMode = (await stat(join(tmpRoot, "learning", "session-one-rust-ownership"))).mode & 0o777;
	assertEqual(workspaceMode, 0o700, "learning workspace should be created with private permissions");
	const rawNote = "  learner heading\n# still learner text\n```ts\nconst x = 1;\n```\n";
	const noted = stateModule.updateLearningState(initial, {}, "2026-07-23T12:01:00.000Z");
	await journal.appendLearnerNote(noted, rawNote, "fixture-note");
	const journalMarkdown = await readFile(join(tmpRoot, initial.journalPath), "utf8");
	assertEqual(journal.extractVerbatimRecord(journalMarkdown, "note", "fixture-note"), rawNote, "learner note should round-trip exactly");
	const parsedJournalState = journal.parseLatestJournalState(journalMarkdown);
	assertEqual(parsedJournalState.revision, 1, "latest journal checkpoint should parse");
	assertEqual(parsedJournalState.cwd, undefined, "portable journal checkpoints should omit absolute cwd");
	assertEqual(parsedJournalState.sessionId, undefined, "portable journal checkpoints should omit session identifiers");
	const forgedPortableMarker = Buffer.from(JSON.stringify({ ...parsedJournalState, unexpected: "discard me" }), "utf8").toString("base64url");
	const sanitizedCheckpoint = journal.parseLatestJournalState(`${journalMarkdown}\n<!-- pi-learning-state:${forgedPortableMarker} -->`);
	assertEqual(sanitizedCheckpoint.unexpected, undefined, "journal checkpoint parsing should discard unknown properties");
	const journalMode = (await stat(join(tmpRoot, initial.journalPath))).mode & 0o777;
	assertEqual(journalMode, 0o600, "journals should be created with private permissions");
	const resumed = await journal.resolveJournalForResume(tmpRoot, initial.journalPath);
	assertEqual(resumed.relativePath, initial.journalPath, "resume should keep project-relative path");
	let traversalBlocked = false;
	try {
		await journal.resolveJournalForResume(tmpRoot, "../outside.md");
	} catch {
		traversalBlocked = true;
	}
	assert(traversalBlocked, "resume traversal should be blocked");
	const publicJournalPath = join(tmpRoot, "learning", "public.md");
	await writeFile(publicJournalPath, journalMarkdown, "utf8");
	await chmod(publicJournalPath, 0o644);
	let publicJournalBlocked = false;
	try {
		await journal.resolveJournalForResume(tmpRoot, "learning/public.md");
	} catch {
		publicJournalBlocked = true;
	}
	assert(publicJournalBlocked, "resume should reject a group/world-readable journal");
	const symlinkProject = join(tmpRoot, "symlink-project");
	const outsideLearning = join(tmpRoot, "outside-learning");
	await mkdir(symlinkProject, { recursive: true });
	await mkdir(outsideLearning, { recursive: true });
	await symlink(outsideLearning, join(symlinkProject, "learning"), "dir");
	let symlinkRootBlocked = false;
	try {
		await journal.createJournalState({
			sessionId: "symlink-session",
			topic: "topic",
			outcome: "outcome",
			cwd: symlinkProject,
			createState: (journalPath) => stateModule.createLearningState({ sessionId: "symlink-session", topic: "topic", outcome: "outcome", cwd: symlinkProject, journalPath }),
		});
	} catch {
		symlinkRootBlocked = true;
	}
	assert(symlinkRootBlocked, "a symlinked learning directory should be blocked");
	const swapState = stateModule.createLearningState({
		sessionId: "swap-session",
		topic: "swap safety",
		outcome: "keep the intended journal target",
		cwd: tmpRoot,
		journalPath: "learning/swap.md",
	});
	await journal.initializeJournal(swapState);
	const swapPath = join(tmpRoot, swapState.journalPath);
	const victimPath = join(tmpRoot, "learning", "victim.md");
	await writeFile(victimPath, "victim stays unchanged\n", { mode: 0o600 });
	await rm(swapPath);
	await symlink("victim.md", swapPath);
	let swappedJournalBlocked = false;
	try {
		await journal.appendExtensionEvent(stateModule.updateLearningState(swapState, {}), "must not reach victim");
	} catch {
		swappedJournalBlocked = true;
	}
	assert(swappedJournalBlocked, "a journal path swapped to a symlink should be blocked");
	assertEqual(await readFile(victimPath, "utf8"), "victim stays unchanged\n", "symlink swap must not modify its target");

	const tutorPrompt = promptModule.buildTutorPrompt(initial, ["read", "web_search", "learning_journal"]);
	assert(tutorPrompt.includes("pull-only technical tutor"), "prompt should establish pull-only tutoring");
	assert(tutorPrompt.includes("roadmap.sh as a secondary source"), "prompt should keep roadmap.sh secondary");
	assert(tutorPrompt.includes("Do not create, edit, patch, complete, or overwrite"), "prompt should prohibit implementation");
	assert(tutorPrompt.includes(join(tmpRoot, "learning", "session-one-rust-ownership")), "prompt should expose the exact learner workspace");
	assert(tutorPrompt.includes("never ask them to paste file contents"), "prompt should prefer direct workspace reads over copy-paste");
	assert(tutorPrompt.includes("never search the whole home directory"), "prompt should prevent broad artifact searches");
	assert(tutorPrompt.includes("novel transfer challenge"), "prompt should require transfer challenge");

	const completionCwd = join(tmpRoot, "autocomplete");
	await mkdir(join(completionCwd, "learning"), { recursive: true });
	await writeFile(join(completionCwd, "learning", "fixture.md"), "# fixture\n");
	assert(commandsModule.buildLearningArgumentCompletions("st", completionCwd).some((item) => item.value === "start"), "start should autocomplete");
	assert(commandsModule.buildLearningArgumentCompletions("resume le", completionCwd).some((item) => item.value === "resume learning/fixture.md"), "resume journals should autocomplete");

	const handlers = new Map();
	const registeredCommands = new Map();
	const registeredTools = new Map();
	const entries = [];
	const branch = [];
	const statuses = new Map();
	const notifications = [];
	const sentMessages = [];
	const fakePi = {
		registerCommand(name, definition) { registeredCommands.set(name, definition); },
		registerTool(definition) { registeredTools.set(definition.name, definition); },
		on(name, handler) { handlers.set(name, handler); },
		appendEntry(customType, data) {
			const entry = {
				id: `entry-${entries.length + 1}`,
				parentId: branch.at(-1)?.id ?? null,
				type: "custom",
				customType,
				data,
			};
			entries.push(entry);
			branch.push(entry);
		},
		sendMessage(message, options) { sentMessages.push({ message, options }); },
		getActiveTools() { return ["read", "bash", "edit", "write", "web_search", "learning_journal"]; },
	};
	extensionModule.default(fakePi);
	assert(registeredCommands.has("learn"), "extension should register /learn");
	assert(registeredTools.has("learning_journal"), "extension should register learning_journal");

	const integrationCwd = join(tmpRoot, "integration");
	await mkdir(integrationCwd, { recursive: true });
	const context = {
		cwd: integrationCwd,
		hasUI: true,
		mode: "tui",
		ui: {
			theme: { fg: (_color, text) => text },
			setStatus: (key, value) => statuses.set(key, value),
			notify: (message, level) => notifications.push({ message, level }),
			input: async () => undefined,
			editor: async () => undefined,
			select: async () => undefined,
			confirm: async () => true,
		},
		sessionManager: {
			getSessionId: () => "integration-session",
			getEntries: () => entries,
			getBranch: () => branch,
		},
		waitForIdle: async () => undefined,
	};
	await handlers.get("session_start")({ reason: "startup" }, context);
	assertEqual(await handlers.get("before_agent_start")({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read"] } }, context), undefined, "inactive mode should not inject a prompt");
	await registeredCommands.get("learn").handler("start TypeScript AST :: build a source transformer", context);
	assert(statuses.get("pi-learning")?.includes("learn: diagnosis"), "activation should set footer status");
	const integrationJournal = journal.listLearningJournals(integrationCwd)[0];
	const integrationWorkspace = journal.workspacePathForJournal(integrationJournal);
	assert((await stat(join(integrationCwd, integrationWorkspace))).isDirectory(), "activation should prepare the matching workspace directory");
	assert(notifications.some(({ message }) => message.includes(`Workspace: ${integrationWorkspace}/`)), "activation should announce the workspace path");
	assert(sentMessages.length === 1 && sentMessages[0].options.triggerTurn === true, "activation should trigger the diagnosis turn");
	const injected = await handlers.get("before_agent_start")({ systemPrompt: "base", systemPromptOptions: { selectedTools: ["read", "web_search"] } }, context);
	assert(injected.systemPrompt.includes("Pi learning mode — ACTIVE"), "active mode should inject tutor instructions");
	const blocked = await handlers.get("tool_call")({ toolName: "write", input: { path: "solution.ts" } }, context);
	assert(blocked?.block === true, "write should be blocked while learning is active");
	assertEqual(await handlers.get("tool_call")({ toolName: "bash", input: { command: "npm test" } }, context), undefined, "bash verification should remain available");

	const learningTool = registeredTools.get("learning_journal");
	let masteryRejected = false;
	try {
		await learningTool.execute("tool-1", { action: "record_mastery", content: "done", artifactEvidence: "file", learnerExplanation: "words" });
	} catch {
		masteryRejected = true;
	}
	assert(masteryRejected, "mastery should require a current module challenge");
	let unresearchedCheckpointRejected = false;
	try {
		await learningTool.execute("tool-2", {
			action: "checkpoint",
			content: "Premature challenge",
			phase: "challenge",
			currentChallenge: "AST visitor",
		});
	} catch {
		unresearchedCheckpointRejected = true;
	}
	assert(unresearchedCheckpointRejected, "curriculum should require recorded research");
	let unsafeSourceRejected = false;
	try {
		await learningTool.execute("tool-source-unsafe", {
			action: "append",
			category: "source",
			content: "unsafe source",
			sourceUrl: "javascript:alert(1)",
			sourceClass: "official-primary",
		});
	} catch {
		unsafeSourceRejected = true;
	}
	assert(unsafeSourceRejected, "source URLs should require HTTP(S)");
	let roadmapPrimaryRejected = false;
	try {
		await learningTool.execute("tool-roadmap-primary", {
			action: "append",
			category: "source",
			content: "incorrectly classified roadmap",
			sourceUrl: "https://roadmap.sh/typescript",
			sourceClass: "official-primary",
		});
	} catch {
		roadmapPrimaryRejected = true;
	}
	assert(roadmapPrimaryRejected, "roadmap.sh must not satisfy the official-primary source gate");
	let credentialUrlRejected = false;
	try {
		await learningTool.execute("tool-source-secret", {
			action: "append",
			category: "source",
			content: "credential URL",
			sourceUrl: "https://example.com/docs?api_key=secret",
			sourceClass: "official-primary",
		});
	} catch {
		credentialUrlRejected = true;
	}
	assert(credentialUrlRejected, "credential-bearing source URLs should be rejected");
	await learningTool.execute("tool-source-1", {
		action: "append",
		category: "source",
		content: "Official TypeScript compiler API reference",
		sourceUrl: "https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API",
		sourceClass: "official-primary",
	});
	await learningTool.execute("tool-source-2", {
		action: "append",
		category: "source",
		content: "roadmap.sh checked for relevant dependencies",
		sourceUrl: "https://roadmap.sh/typescript",
		sourceClass: "secondary",
	});
	const checkpointResult = await learningTool.execute("tool-2", {
		action: "checkpoint",
		content: "Implement the first visitor",
		phase: "challenge",
		currentChallenge: "AST visitor",
	});
	assertEqual(checkpointResult.details.state.phase, "challenge", "checkpoint tool should advance phase");
	await learningTool.execute("tool-3", { action: "record_hint", content: "Inspect node kinds first", hintLevel: 1 });
	const mastery = await learningTool.execute("tool-4", {
		action: "record_mastery",
		content: "Visitor mastered",
		artifactEvidence: "transformer.ts passes its fixture",
		learnerExplanation: "The learner explained traversal order",
	});
	assertEqual(mastery.details.state.completedModules, 1, "mastery should increment completed modules");
	const [parallelA, parallelB] = await Promise.all([
		learningTool.execute("tool-5", { action: "append", category: "synthesis", content: "Parallel record A" }),
		learningTool.execute("tool-6", { action: "append", category: "synthesis", content: "Parallel record B" }),
	]);
	assertEqual(parallelA.details.state.revision + 1, parallelB.details.state.revision, "parallel journal calls should serialize state revisions");

	const commandNote = "  my own note  \n";
	await registeredCommands.get("learn").handler(`note ${commandNote}`, context);
	const integrationJournals = journal.listLearningJournals(integrationCwd);
	let integrationMarkdown = await readFile(join(integrationCwd, integrationJournals[0]), "utf8");
	const noteId = integrationMarkdown.match(/pi-learning-verbatim:note:([^:]+):start/)?.[1];
	assertEqual(journal.extractVerbatimRecord(integrationMarkdown, "note", noteId), commandNote, "command-level note parsing should preserve the handler payload");
	assert(integrationMarkdown.includes("Learner note (verbatim)"), "note command should append a learner-owned record");
	assert(integrationMarkdown.includes("AI synthesis"), "tool actions should append AI-owned records");

	const finalCheckpoint = await learningTool.execute("tool-final", {
		action: "checkpoint",
		content: "Novel transfer challenge",
		phase: "final",
		currentChallenge: "Transform a different AST shape",
	});
	assertEqual(finalCheckpoint.details.state.currentHints.count, 0, "final challenge should start with zero hints");
	const completion = await learningTool.execute("tool-complete", {
		action: "complete",
		content: "Intended outcome reached",
		outcomeEvidence: "The transformer handles the new fixture",
		learnerExplanation: "The learner explained traversal and replacement",
		finalChallengeEvidence: "A novel node shape passed without hints",
	});
	assertEqual(completion.details.state.active, false, "completion should deactivate learning mode");
	await handlers.get("tool_result")({ toolName: "learning_journal" }, context);
	assertEqual(statuses.get("pi-learning"), undefined, "completion should clear status");

	await registeredCommands.get("learn").handler("start Another topic :: build another artifact", context);
	await Promise.all([
		registeredCommands.get("learn").handler("note concurrent note", context),
		registeredCommands.get("learn").handler("off", context),
	]);
	assertEqual(statuses.get("pi-learning"), undefined, "serialized off should clear status without a stale note reactivating it");
	assertEqual(await handlers.get("tool_call")({ toolName: "write", input: { path: "solution.ts" } }, context), undefined, "write should be allowed after /learn off");

	console.log("pi-learning tests passed");
} finally {
	await rm(tmpRoot, { recursive: true, force: true });
}
