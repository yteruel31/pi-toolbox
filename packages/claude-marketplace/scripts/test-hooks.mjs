import { access, mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const tmpRoot = await mkdtemp(join(tmpdir(), "pi-claude-marketplace-hooks-"));
const buildDir = join(tmpRoot, "build");
process.env.PI_CODING_AGENT_DIR = join(tmpRoot, "agent");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

async function writeJson(path, value) {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function gitSync(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function createFixtureMarketplace(root) {
	await writeJson(join(root, ".claude-plugin", "marketplace.json"), {
		name: "fixture-hooks",
		plugins: [{ name: "permission-fixture", version: "1.0.0", source: "./plugins/permission-fixture" }],
	});
	await writeJson(join(root, "plugins", "permission-fixture", ".claude-plugin", "plugin.json"), {
		name: "permission-fixture",
		version: "1.0.0",
		description: "Fixture plugin for hook bridge tests",
		userConfig: {
			api_token: {
				type: "string",
				title: "API token",
				description: "Fixture API token",
				sensitive: true,
				required: true,
			},
			script_arg: {
				type: "string",
				title: "Script argument",
				description: "Fixture hook argument",
				default: "from-default",
			},
		},
	});
	await writeJson(join(root, "plugins", "permission-fixture", "hooks", "hooks.json"), {
		hooks: {
			PreToolUse: [
				{
					matcher: "*",
					hooks: [{ type: "command", command: "node ${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs ${user_config.script_arg}", timeout: 5 }],
				},
			],
		},
	});
	await mkdir(join(root, "plugins", "permission-fixture", "skills", "fixture-skill"), { recursive: true });
	await writeFile(join(root, "plugins", "permission-fixture", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill\n---\n\nInitial fixture skill body.\n");
	await mkdir(join(root, "plugins", "permission-fixture", "agents"), { recursive: true });
	await writeFile(join(root, "plugins", "permission-fixture", "agents", "fixture-agent.md"), "---\nname: fixture-agent\ndescription: Fixture agent\ntools: Read\n---\n\nInitial fixture agent body.\n");
	await mkdir(join(root, "plugins", "permission-fixture", "scripts"), { recursive: true });
	await writeFile(
		join(root, "plugins", "permission-fixture", "scripts", "hook.mjs"),
		`let input = "";\nprocess.stdin.setEncoding("utf8");\nfor await (const chunk of process.stdin) input += chunk;\nconst event = JSON.parse(input);\nconst command = event.tool_input?.command ?? "";\nif (command.includes("blocked")) {\n  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked by fixture" } }));\n} else if (command.includes("ask-me")) {\n  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "fixture asks" } }));\n} else if (command.includes("rewrite")) {\n  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { command: "echo rewritten" } } }));\n} else if (command.includes("user-config")) {\n  const ok = process.env.CLAUDE_PLUGIN_OPTION_API_TOKEN === "secret-token" && process.argv[2] === "from-default";\n  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: ok ? "allow" : "deny", permissionDecisionReason: ok ? "fixture userConfig ok" : "fixture userConfig missing" } }));\n} else {\n  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "fixture allow" } }));\n}\n`,
	);
}

async function createExternalPluginRepo(root) {
	const pluginRoot = join(root, "plugins", "external-fixture");
	await writeJson(join(pluginRoot, ".claude-plugin", "plugin.json"), {
		name: "external-fixture",
		version: "2.0.0",
		description: "Fixture external plugin",
	});
	await mkdir(join(pluginRoot, "commands"), { recursive: true });
	await writeFile(join(pluginRoot, "commands", "hello.md"), "---\ndescription: Say hello from a fixture command\nargument-hint: <name>\n---\n\nSay hello from $ARGUMENTS.\n");
	await mkdir(join(pluginRoot, "skills", "external-skill"), { recursive: true });
	await writeFile(join(pluginRoot, "skills", "external-skill", "SKILL.md"), "---\nname: external-skill\ndescription: |\n  External fixture skill with a multiline description.\n  This catches generated frontmatter rewrites.\nargument-hint: <topic>\n---\n\nExternal fixture skill body.\n");
	await mkdir(join(pluginRoot, "agents"), { recursive: true });
	await writeFile(join(pluginRoot, "agents", "external-agent.md"), "---\nname: external-agent\ndescription: External fixture agent\ntools: Read\n---\n\nExternal fixture agent body.\n");

	gitSync(root, ["init", "-b", "main"]);
	gitSync(root, ["config", "user.email", "fixture@example.com"]);
	gitSync(root, ["config", "user.name", "Fixture"]);
	gitSync(root, ["add", "."]);
	gitSync(root, ["commit", "-m", "fixture external plugin"]);
	return gitSync(root, ["rev-parse", "HEAD"]);
}

async function createExternalMarketplace(root, repoPath, sha) {
	await writeJson(join(root, ".claude-plugin", "marketplace.json"), {
		name: "fixture-external",
		plugins: [
			{
				name: "external-fixture",
				version: "2.0.0",
				source: { source: "github", repo: repoPath, ref: "main", sha, path: "plugins/external-fixture" },
			},
		],
	});
}

try {
	execFileSync(process.execPath, [join(repoRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(packageRoot, "tsconfig.json"), "--outDir", buildDir, "--noEmit", "false"], {
		cwd: packageRoot,
		stdio: "inherit",
	});

	const fixtureRoot = join(tmpRoot, "marketplace");
	await createFixtureMarketplace(fixtureRoot);

	const { loadMarketplaceFromSource } = await import(pathToFileURL(join(buildDir, "registry", "marketplace-loader.js")));
	const { upsertMarketplace, writeMarketplacesStore } = await import(pathToFileURL(join(buildDir, "registry", "marketplace-store.js")));
	const { resolvePluginSpecs } = await import(pathToFileURL(join(buildDir, "plugins", "plugin-index.js")));
	const { installIndexedPlugins } = await import(pathToFileURL(join(buildDir, "plugins", "installer.js")));
	const { readInstalledPluginsStore, removeInstalledPlugins } = await import(pathToFileURL(join(buildDir, "plugins", "installed-store.js")));
	const { refreshMarketplacesCommand } = await import(pathToFileURL(join(buildDir, "commands", "marketplaces.js")));
	const { readHookBridgeStore } = await import(pathToFileURL(join(buildDir, "hooks", "hook-store.js")));
	const { runPreToolUseHooks } = await import(pathToFileURL(join(buildDir, "hooks", "runner.js")));
	const { marketplaceEnvPath } = await import(pathToFileURL(join(buildDir, "state", "paths.js")));
	const { buildClaudeMarketplaceAutocompleteDisplays } = await import(pathToFileURL(join(buildDir, "session", "autocomplete-display.js")));

	const { stored } = await loadMarketplaceFromSource(fixtureRoot);
	await writeMarketplacesStore((await upsertMarketplace(stored)).store);
	const [indexed] = await resolvePluginSpecs(["permission-fixture@fixture-hooks"]);
	const [installed] = await installIndexedPlugins([indexed]);
	await mkdir(dirname(marketplaceEnvPath("fixture-hooks")), { recursive: true });
	await writeFile(marketplaceEnvPath("fixture-hooks"), "CLAUDE_PLUGIN_OPTION_API_TOKEN=secret-token\n");

	const afterInstall = await readHookBridgeStore();
	assert(afterInstall.hooks.length === 1, `expected install to auto-enable 1 hook, got ${afterInstall.hooks.length}`);
	assert(afterInstall.hooks[0].event === "PreToolUse", "expected PreToolUse hook to be enabled");

	const generatedLocalSkillPath = join(process.env.PI_CODING_AGENT_DIR, "claude-marketplace", "generated", "fixture-hooks", "permission-fixture", "skills", "claude-permission-fixture-fixture-skill", "SKILL.md");
	const generatedLocalAgentPath = join(process.env.PI_CODING_AGENT_DIR, "agents", "claude-marketplace", "fixture-hooks", "permission-fixture", "claude-fixture-hooks-permission-fixture-fixture-agent.md");
	assert((await readFile(generatedLocalSkillPath, "utf8")).includes("Initial fixture skill body."), "expected initial generated skill body");
	assert((await readFile(generatedLocalAgentPath, "utf8")).includes("Initial fixture agent body."), "expected initial generated agent body");
	await writeJson(join(fixtureRoot, "plugins", "permission-fixture", ".claude-plugin", "plugin.json"), {
		name: "permission-fixture",
		version: "1.1.0",
		description: "Updated fixture plugin for refresh tests",
		userConfig: {
			api_token: {
				type: "string",
				title: "API token",
				description: "Fixture API token",
				sensitive: true,
				required: true,
			},
			script_arg: {
				type: "string",
				title: "Script argument",
				description: "Fixture hook argument",
				default: "from-default",
			},
		},
	});
	await writeFile(join(fixtureRoot, "plugins", "permission-fixture", "skills", "fixture-skill", "SKILL.md"), "---\nname: fixture-skill\ndescription: Fixture skill\n---\n\nUpdated fixture skill body.\n");
	await writeFile(join(fixtureRoot, "plugins", "permission-fixture", "agents", "fixture-agent.md"), "---\nname: fixture-agent\ndescription: Fixture agent\ntools: Read\n---\n\nUpdated fixture agent body.\n");
	const refreshMessages = [];
	await refreshMarketplacesCommand("", { ui: { notify: (message) => refreshMessages.push(message) } });
	const refreshedStore = await readInstalledPluginsStore();
	const refreshedInstalled = refreshedStore.plugins.find((plugin) => plugin.id === installed.id);
	assert(refreshedInstalled?.version === "1.1.0", `expected refresh to update installed plugin version, got ${refreshedInstalled?.version}`);
	assert(refreshedInstalled.cachePath !== installed.cachePath, "expected refresh to move cache to the updated version path");
	assert(!(await exists(installed.cachePath)), "expected refresh to remove obsolete plugin cache after successful regeneration");
	assert((await readFile(generatedLocalSkillPath, "utf8")).includes("Updated fixture skill body."), "expected refresh to regenerate skill body");
	assert((await readFile(generatedLocalAgentPath, "utf8")).includes("Updated fixture agent body."), "expected refresh to regenerate agent body");
	assert(refreshMessages.some((message) => message.includes("Updated 1 installed plugin(s), including generated skills and agents.")), "expected refresh notification to mention generated resources");

	const ctx = {
		cwd: packageRoot,
		hasUI: false,
		signal: undefined,
		ui: { notify: () => undefined, confirm: async () => false },
	};
	const safeInput = { command: "echo safe" };
	assert((await runPreToolUseHooks({ type: "tool_call", toolCallId: "safe", toolName: "bash", input: safeInput }, ctx)) === undefined, "expected safe command to be allowed");

	const denied = await runPreToolUseHooks({ type: "tool_call", toolCallId: "deny", toolName: "bash", input: { command: "echo blocked" } }, ctx);
	assert(denied?.block === true && denied.reason === "blocked by fixture", "expected denied command to block with fixture reason");

	const ask = await runPreToolUseHooks({ type: "tool_call", toolCallId: "ask", toolName: "bash", input: { command: "echo ask-me" } }, ctx);
	assert(ask?.block === true && ask.reason === "fixture asks", "expected ask decision to block without UI");

	const rewriteInput = { command: "echo rewrite" };
	assert((await runPreToolUseHooks({ type: "tool_call", toolCallId: "rewrite", toolName: "bash", input: rewriteInput }, ctx)) === undefined, "expected rewritten command to be allowed");
	assert(rewriteInput.command === "echo rewritten", `expected updatedInput to rewrite command, got ${rewriteInput.command}`);

	const userConfigInput = { command: "echo user-config" };
	assert((await runPreToolUseHooks({ type: "tool_call", toolCallId: "user-config", toolName: "bash", input: userConfigInput }, ctx)) === undefined, "expected userConfig env and placeholder substitution to be available to hook commands");

	await removeInstalledPlugins([installed.id]);
	assert((await readHookBridgeStore()).hooks.length === 0, "expected uninstall to remove enabled hooks");
	assert(!(await exists(installed.cachePath)), "expected uninstall to remove plugin cache");

	const externalRepo = join(tmpRoot, "external-repo");
	await mkdir(externalRepo, { recursive: true });
	const externalSha = await createExternalPluginRepo(externalRepo);
	const externalMarketplaceRoot = join(tmpRoot, "external-marketplace");
	await createExternalMarketplace(externalMarketplaceRoot, externalRepo, externalSha);
	const { stored: externalStored } = await loadMarketplaceFromSource(externalMarketplaceRoot);
	await writeMarketplacesStore((await upsertMarketplace(externalStored)).store);
	const [externalIndexed] = await resolvePluginSpecs(["external-fixture@fixture-external"]);
	assert(externalIndexed.sourceType === "github", `expected github source type, got ${externalIndexed.sourceType}`);
	assert(!externalIndexed.components, "expected external components to be unavailable before install");
	const [externalInstalled] = await installIndexedPlugins([externalIndexed]);
	assert(externalInstalled.sourceType === "github", `expected installed sourceType github, got ${externalInstalled.sourceType}`);
	assert(externalInstalled.components.commands.includes("hello"), "expected external command component to be scanned after install");
	assert(externalInstalled.components.skills.includes("external-skill"), "expected external skill component to be scanned after install");
	assert(externalInstalled.components.agents.includes("external-agent"), "expected external agent component to be scanned after install");
	assert(await exists(join(externalInstalled.cachePath, "commands", "hello.md")), "expected external plugin to be copied into cache");
	const autocompleteDisplays = buildClaudeMarketplaceAutocompleteDisplays();
	const commandDisplay = autocompleteDisplays.get("claude-marketplace-external-fixture-hello");
	assert(commandDisplay?.label === "claude-marketplace:external-fixture:hello", `expected pretty command label, got ${commandDisplay?.label}`);
	assert(commandDisplay?.description === "(fixture-external:external-fixture): <name> — Say hello from a fixture command", `expected enriched command description, got ${commandDisplay?.description}`);
	const skillDisplay = autocompleteDisplays.get("skill:claude-external-fixture-external-skill");
	assert(skillDisplay?.label === "skill:external-skill", `expected pretty skill label, got ${skillDisplay?.label}`);
	assert(skillDisplay?.description.includes("(fixture-external:external-fixture): <topic> — External fixture skill with a multiline description."), `expected enriched skill description, got ${skillDisplay?.description}`);
	const generatedSkill = await readFile(
		join(process.env.PI_CODING_AGENT_DIR, "claude-marketplace", "generated", "fixture-external", "external-fixture", "skills", "claude-external-fixture-external-skill", "SKILL.md"),
		"utf8",
	);
	assert(!generatedSkill.includes('description: "|"'), "expected block-scalar description to be flattened, not quoted as a literal pipe");
	assert(generatedSkill.includes("(fixture-external:external-fixture): <topic>"), "expected generated skill description to include marketplace/plugin and argument hint");
	assert(generatedSkill.includes("External fixture skill with a multiline description."), "expected block-scalar description text to be preserved");
	await removeInstalledPlugins([externalInstalled.id]);
	assert(!(await exists(externalInstalled.cachePath)), "expected external uninstall to remove plugin cache");

	console.log("hook bridge and external source tests passed");
} finally {
	await rm(tmpRoot, { recursive: true, force: true });
}
