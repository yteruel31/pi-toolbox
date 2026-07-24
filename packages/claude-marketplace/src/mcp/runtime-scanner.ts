import { access, readFile, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import type { InstalledPlugin } from "../plugins/types.js";
import { collectPluginUserConfigSpecs } from "../plugins/user-config.js";
import { collectEnvReferences, resolveEnvReference } from "./env.js";
import type { EnvReference, McpServerConfig, McpServerDiagnostics, RuntimeDiagnostic } from "./types.js";

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function commandAvailable(command: string): Promise<boolean> {
	if (command.includes("/")) {
		try {
			await access(command);
			return true;
		} catch {
			return false;
		}
	}
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (dir && (await pathExists(join(dir, command)))) return true;
	}
	return false;
}

function pathUnder(path: string, root: string): boolean {
	const resolved = resolve(path);
	const resolvedRoot = resolve(root);
	return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}/`);
}

function findLocalServerDirectory(config: McpServerConfig, plugin: InstalledPlugin): string | undefined {
	if (typeof config.cwd === "string" && pathUnder(config.cwd, plugin.cachePath)) return config.cwd;
	for (const value of [config.command, ...(config.args ?? [])]) {
		if (typeof value !== "string") continue;
		const path = isAbsolute(value) ? value : undefined;
		if (path && pathUnder(path, plugin.cachePath)) return dirname(path);
	}
	return undefined;
}

async function readRunScript(serverDirectory: string | undefined): Promise<string> {
	if (!serverDirectory) return "";
	try {
		return await readFile(join(serverDirectory, "run.sh"), "utf8");
	} catch {
		return "";
	}
}

function inferRuntimeCommands(config: McpServerConfig, script: string): string[] {
	const commands = new Set<string>();
	if (config.command) commands.add(config.command.split("/").at(-1) ?? config.command);
	if (/\buv\s+run\b/.test(script)) commands.add("uv");
	if (/\bpython3?\b/.test(script)) commands.add("python3");
	if (/\bnpm\s+(install|ci|run)\b/.test(script)) commands.add("npm");
	if (/\bnpx\b/.test(script) || config.command === "npx") commands.add("npx");
	if (/\bnode\b/.test(script)) commands.add("node");
	if (/\bpip(3)?\s+install\b/.test(script)) commands.add("pip");
	return [...commands].filter(Boolean).sort();
}

async function existingServerFiles(serverDirectory: string | undefined): Promise<string[]> {
	if (!serverDirectory) return [];
	const names = ["run.sh", "package.json", "package-lock.json", "pnpm-lock.yaml", "pyproject.toml", "requirements.txt", "uv.lock", "node_modules", ".venv", "dist"];
	const found: string[] = [];
	for (const name of names) {
		if (await pathExists(join(serverDirectory, name))) found.push(name);
	}
	return found;
}

function riskNotes(config: McpServerConfig, localCode: boolean, script: string): string[] {
	const notes: string[] = [];
	if (localCode) notes.push("executes local plugin code");
	if (/\buv\s+run\b/.test(script)) notes.push("uv may download Python dependencies on first execution");
	if (/\bnpm\s+install\b/.test(script)) notes.push("npm install may run on first execution");
	if (/\bpip(3)?\s+install\b/.test(script)) notes.push("pip install may run on first execution");
	if (config.command === "npx" || (config.args ?? []).some((arg) => arg === "-y" || arg.includes("@latest"))) notes.push("npx/remote package execution may download code");
	if (/curl\b.*\|\s*(sh|bash)/.test(script)) notes.push("script contains curl-to-shell pattern");
	if (/\brm\s+-rf\b/.test(script)) notes.push("script contains rm -rf");
	if (config.url) notes.push("connects to remote MCP endpoint");
	return [...new Set(notes)];
}

async function collectPluginUserConfigEnvReferences(plugin: InstalledPlugin): Promise<EnvReference[]> {
	const refs: EnvReference[] = [];
	for (const spec of await collectPluginUserConfigSpecs(plugin)) refs.push(await resolveEnvReference(plugin.marketplace, { name: spec.envName, defaultValue: spec.defaultValue }));
	return refs;
}

export async function scanMcpServerDiagnostics(rawConfig: McpServerConfig, transformedConfig: McpServerConfig, plugin: InstalledPlugin): Promise<McpServerDiagnostics> {
	const serverDirectory = findLocalServerDirectory(transformedConfig, plugin);
	const localCode = serverDirectory !== undefined;
	const script = await readRunScript(serverDirectory);
	const runtimeNames = inferRuntimeCommands(transformedConfig, script);
	const runtimes: RuntimeDiagnostic[] = [];
	for (const command of runtimeNames) {
		runtimes.push({ command, available: await commandAvailable(command) });
	}

	return {
		localCode,
		serverDirectory,
		env: [...(await collectEnvReferences(rawConfig, plugin.marketplace)), ...(await collectPluginUserConfigEnvReferences(plugin))],
		runtimes,
		files: await existingServerFiles(serverDirectory),
		riskNotes: riskNotes(transformedConfig, localCode, script),
	};
}
