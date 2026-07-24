import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, realpath, stat, writeFile } from "node:fs/promises";
import { constants, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

import { LEARNING_DIRECTORY, type JournalCheckpoint, type LearningState } from "./contracts.js";
import { parseJournalCheckpoint } from "./contracts.js";

const STATE_MARKER_PREFIX = "<!-- pi-learning-state:";
const STATE_MARKER_SUFFIX = " -->";
const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;
const MAX_STATE_MARKERS = 5_000;
const MAX_ENCODED_STATE_LENGTH = 64 * 1024;

export type AiJournalCategory = "diagnosis" | "source" | "path" | "challenge" | "hint" | "synthesis" | "correction" | "mastery" | "final" | "checkpoint";

export type AiJournalRecord = {
	category: AiJournalCategory;
	content: string;
	title?: string;
	sourceUrl?: string;
	sourceClass?: "official-primary" | "secondary";
};

function slugify(value: string): string {
	const slug = value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 48);
	return slug || "learning-path";
}

function portableCheckpoint(state: LearningState): JournalCheckpoint {
	const { sessionId: _sessionId, cwd: _cwd, journalPath: _journalPath, ...checkpoint } = state;
	return checkpoint;
}

function encodeState(state: LearningState): string {
	return Buffer.from(JSON.stringify(portableCheckpoint(state)), "utf8").toString("base64url");
}

export function stateMarker(state: LearningState): string {
	return `${STATE_MARKER_PREFIX}${encodeState(state)}${STATE_MARKER_SUFFIX}`;
}

export function parseLatestJournalState(markdown: string): JournalCheckpoint | undefined {
	const pattern = /<!-- pi-learning-state:([A-Za-z0-9_-]+) -->/g;
	let latest: JournalCheckpoint | undefined;
	let markerCount = 0;
	for (const match of markdown.matchAll(pattern)) {
		markerCount += 1;
		const encoded = match[1] ?? "";
		if (markerCount > MAX_STATE_MARKERS || encoded.length > MAX_ENCODED_STATE_LENGTH) return undefined;
		try {
			const candidate = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
			const checkpoint = parseJournalCheckpoint(candidate);
			if (checkpoint) latest = checkpoint;
		} catch {
			// Ignore damaged historical markers and keep scanning for a later valid checkpoint.
		}
	}
	return latest;
}

function verbatimRecord(label: "topic" | "outcome" | "note", content: string, id: string = randomUUID()): string {
	const bytes = Buffer.byteLength(content, "utf8");
	return `<!-- pi-learning-verbatim:${label}:${id}:start bytes=${bytes} -->\n${content}<!-- pi-learning-verbatim:${label}:${id}:end -->`;
}

export function extractVerbatimRecord(markdown: string, label: "topic" | "outcome" | "note", id: string): string | undefined {
	const startPrefix = `<!-- pi-learning-verbatim:${label}:${id}:start bytes=`;
	const startIndex = markdown.indexOf(startPrefix);
	if (startIndex < 0) return undefined;
	const contentStart = markdown.indexOf("-->\n", startIndex);
	if (contentStart < 0) return undefined;
	const endMarker = `<!-- pi-learning-verbatim:${label}:${id}:end -->`;
	const contentEnd = markdown.indexOf(endMarker, contentStart + 4);
	if (contentEnd < 0) return undefined;
	return markdown.slice(contentStart + 4, contentEnd);
}

export function learningDirectory(cwd: string): string {
	return join(cwd, LEARNING_DIRECTORY);
}

export function workspacePathForJournal(journalPath: string): string {
	const normalized = journalPath.replaceAll("\\", "/");
	if (dirname(normalized) !== LEARNING_DIRECTORY || !normalized.endsWith(".md")) {
		throw new Error("A learning workspace requires a direct Markdown journal under learning/");
	}
	return `${LEARNING_DIRECTORY}/${basename(normalized, ".md")}`;
}

async function ensureLearningDirectory(cwd: string): Promise<string> {
	const directory = learningDirectory(cwd);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const info = await lstat(directory);
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw new Error("The project learning path must be a real directory, not a symlink");
	}
	if ((info.mode & 0o077) !== 0) await chmod(directory, 0o700);
	const [realCwd, realDirectory] = await Promise.all([realpath(cwd), realpath(directory)]);
	const relativeDirectory = relative(realCwd, realDirectory);
	if (relativeDirectory.startsWith("..") || relativeDirectory.includes(`${sep}..${sep}`)) {
		throw new Error("The project learning directory resolves outside the working directory");
	}
	return realDirectory;
}

export async function ensureLearningWorkspace(
	cwd: string,
	journalPath: string,
): Promise<{ absolutePath: string; relativePath: string }> {
	const root = await ensureLearningDirectory(cwd);
	const relativePath = workspacePathForJournal(journalPath);
	const absolutePath = resolve(cwd, relativePath);
	if ((await realpath(dirname(absolutePath))) !== root) {
		throw new Error("The learning workspace parent resolves outside learning/");
	}
	await mkdir(absolutePath, { recursive: true, mode: 0o700 });
	const info = await lstat(absolutePath);
	if (!info.isDirectory() || info.isSymbolicLink()) {
		throw new Error("The learning workspace must be a real directory, not a symlink");
	}
	if ((info.mode & 0o077) !== 0) await chmod(absolutePath, 0o700);
	const realWorkspace = await realpath(absolutePath);
	if (dirname(realWorkspace) !== root) throw new Error("The learning workspace resolves outside learning/");
	return { absolutePath: realWorkspace, relativePath };
}

async function resolveExistingJournalPath(cwd: string, journalPath: string): Promise<string> {
	const root = await ensureLearningDirectory(cwd);
	const lexicalPath = resolve(cwd, journalPath);
	const parent = await realpath(dirname(lexicalPath));
	if (parent !== root || dirname(journalPath.replaceAll("\\", "/")) !== LEARNING_DIRECTORY) {
		throw new Error("The learning journal must be a direct Markdown file under the project learning directory");
	}
	const info = await lstat(lexicalPath);
	if (info.isSymbolicLink()) throw new Error("The learning journal path must not be a symlink");
	return lexicalPath;
}

export function listLearningJournals(cwd: string): string[] {
	try {
		return readdirSync(learningDirectory(cwd), { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
			.map((entry) => `${LEARNING_DIRECTORY}/${entry.name}`)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

export async function initializeJournal(state: LearningState): Promise<void> {
	const directory = await ensureLearningDirectory(state.cwd);
	const workspace = await ensureLearningWorkspace(state.cwd, state.journalPath);
	const absolutePath = resolve(directory, basename(state.journalPath));
	const markdown = [
		`# Learning path: ${state.topic.replaceAll("\n", " ")}`,
		"",
		`Created: ${state.createdAt}`,
		"",
		"## Learner-provided goal",
		"",
		"### Topic (verbatim)",
		"",
		verbatimRecord("topic", state.topic),
		"",
		"### Intended outcome (verbatim)",
		"",
		verbatimRecord("outcome", state.outcome),
		"",
		"## Activity",
		"",
		`### Extension event · ${state.createdAt}`,
		"",
		"Learning mode activated. The learner keeps the initiative.",
		`Learner workspace prepared at \`${workspace.relativePath}/\`.`,
		"",
		stateMarker(state),
		"",
	].join("\n");
	await writeFile(absolutePath, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function createJournalState(input: {
	sessionId: string;
	topic: string;
	outcome: string;
	cwd: string;
	createState: (journalPath: string) => LearningState;
}): Promise<LearningState> {
	await ensureLearningDirectory(input.cwd);
	const base = slugify(input.topic);
	for (let suffix = 0; suffix < 100; suffix += 1) {
		const filename = `${base}${suffix === 0 ? "" : `-${suffix + 1}`}.md`;
		const journalPath = `${LEARNING_DIRECTORY}/${filename}`;
		const state = input.createState(journalPath);
		try {
			await initializeJournal(state);
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
	throw new Error("Unable to allocate a unique learning journal filename");
}

async function appendWithoutFollowingSymlinks(path: string, content: string): Promise<void> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		throw new Error("The learning journal must be a regular file with a single link");
	}
	if ((before.mode & 0o077) !== 0) throw new Error("The learning journal must have private permissions; run chmod 600 on it");
	if (before.size + Buffer.byteLength(content, "utf8") > MAX_JOURNAL_BYTES) {
		throw new Error("The learning journal would exceed the 5 MB limit");
	}
	const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1) {
			throw new Error("The learning journal changed before append");
		}
		await handle.appendFile(content, "utf8");
	} finally {
		await handle.close();
	}
}

async function readJournalWithoutFollowingSymlinks(path: string): Promise<string> {
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		throw new Error("The learning journal must be a regular file with a single link");
	}
	if ((before.mode & 0o077) !== 0) throw new Error("The learning journal must have private permissions; run chmod 600 on it");
	if (before.size > MAX_JOURNAL_BYTES) throw new Error("The learning journal exceeds the 5 MB resume limit");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_JOURNAL_BYTES) {
			throw new Error("The learning journal changed before it could be read");
		}
		return await handle.readFile("utf8");
	} finally {
		await handle.close();
	}
}

async function appendRecord(state: LearningState, markdown: string): Promise<void> {
	const absolutePath = await resolveExistingJournalPath(state.cwd, state.journalPath);
	await withFileMutationQueue(absolutePath, async () => {
		const safePath = await resolveExistingJournalPath(state.cwd, state.journalPath);
		if (safePath !== absolutePath) throw new Error("The learning journal changed while waiting to append");
		await appendWithoutFollowingSymlinks(safePath, `${markdown}\n\n${stateMarker(state)}\n`);
	});
}

export async function appendLearnerNote(state: LearningState, note: string, id: string = randomUUID()): Promise<string> {
	const markdown = [`### Learner note (verbatim) · ${state.updatedAt}`, "", verbatimRecord("note", note, id)].join("\n");
	await appendRecord(state, markdown);
	return id;
}

export async function appendExtensionEvent(state: LearningState, content: string): Promise<void> {
	await appendRecord(state, [`### Extension event · ${state.updatedAt}`, "", content].join("\n"));
}

function quoteMarkdown(content: string): string {
	return content.split("\n").map((line) => `> ${line}`).join("\n");
}

export async function appendAiRecord(state: LearningState, record: AiJournalRecord): Promise<void> {
	const metadata: string[] = [`Category: ${record.category}`];
	if (record.sourceClass) metadata.push(`Source class: ${record.sourceClass}`);
	if (record.sourceUrl) metadata.push(`URL: ${record.sourceUrl}`);
	const title = record.title ? ` — ${record.title.replace(/[\r\n]+/g, " ")}` : "";
	const markdown = [
		`### AI synthesis · ${state.updatedAt}${title}`,
		"",
		...metadata.map((item) => `- ${item}`),
		"",
		quoteMarkdown(record.content),
	].join("\n");
	await appendRecord(state, markdown);
}

export async function resolveJournalForResume(cwd: string, requestedPath: string): Promise<{ absolutePath: string; relativePath: string; state: JournalCheckpoint }> {
	const normalized = requestedPath.trim().replace(/^@/, "");
	if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
		throw new Error("Use a project-relative journal path under learning/");
	}

	const root = await ensureLearningDirectory(cwd);
	const requestedAbsolutePath = resolve(cwd, normalized);
	const requestedInfo = await lstat(requestedAbsolutePath);
	if (requestedInfo.isSymbolicLink()) throw new Error("The journal path must not be a symlink");
	const absolutePath = await realpath(requestedAbsolutePath);
	const relativeToRoot = relative(root, absolutePath);
	if (!relativeToRoot || relativeToRoot.startsWith("..") || relativeToRoot.includes(sep)) {
		throw new Error("The journal must be a direct Markdown file under learning/");
	}
	const info = await stat(absolutePath);
	if (!info.isFile() || !basename(absolutePath).endsWith(".md")) {
		throw new Error("The journal must be an existing Markdown file under learning/");
	}
	const markdown = await readJournalWithoutFollowingSymlinks(absolutePath);
	const state = parseLatestJournalState(markdown);
	if (!state) throw new Error("No valid pi-learning checkpoint was found in this journal");
	return { absolutePath, relativePath: `${LEARNING_DIRECTORY}/${relativeToRoot.replaceAll(sep, "/")}`, state };
}
