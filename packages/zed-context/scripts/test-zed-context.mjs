import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = join(packageRoot, "..", "..");
const tmpRoot = await mkdtemp(join(tmpdir(), "pi-zed-context-test-"));
const buildDir = join(tmpRoot, "build");
const stateDir = join(tmpRoot, "state");
const workspace = join(tmpRoot, "workspace");
const selectedFile = join(workspace, "src", "invoice.ts");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
	if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

try {
	await symlink(join(repositoryRoot, "node_modules"), join(tmpRoot, "node_modules"), "dir");
	execFileSync(
		process.execPath,
		[
			join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
			"-p",
			join(packageRoot, "tsconfig.json"),
			"--outDir",
			buildDir,
			"--noEmit",
			"false",
		],
		{ cwd: packageRoot, stdio: "inherit" },
	);

	const captureModule = await import(pathToFileURL(join(buildDir, "capture.js")));
	assertEqual(captureModule.countSelectedLines("const a = 1;"), 1, "a single line selection should count as one line");
	assertEqual(captureModule.countSelectedLines("one\ntwo\nthree"), 3, "multiline selections should count touched content lines");
	assertEqual(captureModule.countSelectedLines("one\ntwo\n"), 2, "a trailing newline should not create a phantom line");
	assertEqual(captureModule.countSelectedLines(""), 0, "empty selections should have no lines");

	const oversized = `${"😀".repeat(30_000)}\n${"line\n".repeat(2_100)}`;
	const bounded = captureModule.boundSelection(oversized);
	assert(bounded.truncated, "oversized selection context should be marked as truncated");
	assert(Buffer.byteLength(bounded.text, "utf8") <= captureModule.MAX_CONTEXT_BYTES, "selection context must respect the byte limit");
	assert(bounded.text.split("\n").length <= captureModule.MAX_CONTEXT_LINES, "selection context must respect the line limit");
	assert(!bounded.text.endsWith("\ud83d"), "UTF-8 truncation must not leave a dangling surrogate");

	await mkdir(dirname(selectedFile), { recursive: true });
	await mkdir(join(workspace, ".git"));
	await writeFile(selectedFile, "first\nsecond\nthird\n");
	await new Promise((resolve) => setTimeout(resolve, 5));
	execFileSync(
		process.execPath,
		[
			join(packageRoot, "bin", "pi-zed-context.mjs"),
			"capture",
			"--workspace",
			workspace,
			"--file",
			selectedFile,
			"--row",
			"7",
		],
		{
			env: {
				...process.env,
				PI_ZED_CONTEXT_STATE_DIR: stateDir,
				ZED_SELECTED_TEXT: "first\nsecond\nthird",
			},
			stdio: "pipe",
		},
	);

	const capture = captureModule.latestCapture(workspace, {
		after: 0,
		env: { ...process.env, PI_ZED_CONTEXT_STATE_DIR: stateDir },
	});
	assert(capture, "the helper should write a discoverable capture");
	assertEqual(capture.lineCount, 3, "the helper should persist the selected line count");
	assertEqual(capture.cursorRow, 7, "the helper should persist Zed's cursor row");
	assertEqual((await stat(stateDir)).mode & 0o777, 0o700, "selection state should be private to the current user");
	assert(!captureModule.captureMatchesCwd({ ...capture, workspace: tmpRoot, file: join(tmpRoot, "other", "secret.ts") }, workspace), "a broad Zed workspace must not leak another repository's selection into this Pi session");
	assertEqual(captureModule.latestCapture(join(tmpRoot, "other"), {
		after: 0,
		env: { ...process.env, PI_ZED_CONTEXT_STATE_DIR: stateDir },
	}), undefined, "captures should not leak to unrelated Pi working directories");

	const extension = await import(pathToFileURL(join(buildDir, "index.js")));
	const helperHome = join(tmpRoot, "helper-home");
	const installedHelper = extension.installHelper(helperHome, join(packageRoot, "bin", "pi-zed-context.mjs"));
	assert((await readFile(installedHelper, "utf8")).includes("pi-zed-context.mjs"), "setup should install an executable helper wrapper");
	execFileSync(installedHelper, ["capture", "--workspace", workspace, "--file", selectedFile], {
		env: { ...process.env, PI_ZED_CONTEXT_STATE_DIR: stateDir, ZED_SELECTED_TEXT: "wrapper capture" },
		stdio: "pipe",
	});

	const handlers = new Map();
	const commands = new Map();
	const fakePi = {
		on(name, handler) { handlers.set(name, handler); },
		registerCommand(name, command) { commands.set(name, command); },
	};
	extension.default(fakePi);
	assert(commands.has("zed-context"), "the extension should register /zed-context");

	const statuses = [];
	const notifications = [];
	const context = {
		cwd: workspace,
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg(_color, text) { return text; } },
			setStatus(key, value) { statuses.push({ key, value }); },
			notify(message, level) { notifications.push({ message, level }); },
		},
	};

	process.env.PI_ZED_CONTEXT_STATE_DIR = stateDir;
	await handlers.get("session_start")({ reason: "startup" }, context);
	await new Promise((resolve) => setTimeout(resolve, 5));
	execFileSync(
		process.execPath,
		[join(packageRoot, "bin", "pi-zed-context.mjs"), "capture", "--workspace", workspace, "--file", selectedFile],
		{ env: { ...process.env, ZED_SELECTED_TEXT: "alpha\nbeta" }, stdio: "pipe" },
	);

	const injected = await handlers.get("before_agent_start")({ prompt: "Explain this" }, context);
	assert(injected?.message?.content.includes("selected-lines=\"2\""), "the next prompt should receive the selected line count");
	assert(injected?.message?.content.includes("alpha\nbeta"), "the next prompt should receive the selected code");
	assert(statuses.at(-1)?.value.includes("2 lignes sélectionnées"), "Pi's footer should show the explicit selected-line count");
	assertEqual(await handlers.get("before_agent_start")({ prompt: "Do not attach twice" }, context), undefined, "a capture should attach only once");

	await commands.get("zed-context").handler("status", context);
	assert(notifications.at(-1)?.message.includes("Attached"), "the status command should describe the last attached capture");
	await commands.get("zed-context").handler("clear", context);
	assertEqual(statuses.at(-1)?.value, undefined, "clearing should remove the footer status");
	await handlers.get("session_shutdown")({ reason: "quit" }, context);

	console.log("pi-zed-context tests passed");
} finally {
	delete process.env.PI_ZED_CONTEXT_STATE_DIR;
	await rm(tmpRoot, { recursive: true, force: true });
}
