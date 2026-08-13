import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { parseGitHubRemote, type GitHubRepository } from "./urls.js";

const execFileAsync = promisify(execFile);

export interface GitRunner {
	(args: string[], cwd: string): Promise<string>;
}

export interface RepositoryContext {
	repository: GitHubRepository;
	branch?: string;
}

export const runGit: GitRunner = async (args, cwd) => {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		encoding: "utf8",
		timeout: 3_000,
		maxBuffer: 256 * 1024,
	});
	return stdout.trim();
};

async function optionalGit(runner: GitRunner, args: string[], cwd: string): Promise<string | undefined> {
	try {
		const value = (await runner(args, cwd)).trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

async function remoteUrl(runner: GitRunner, cwd: string, name: string): Promise<string> {
	const push = await optionalGit(runner, ["remote", "get-url", "--push", name], cwd);
	const value = push ?? await optionalGit(runner, ["remote", "get-url", name], cwd);
	if (!value) throw new Error("The selected Git remote has no usable URL.");
	return value;
}

function configuredRemote(value: string | undefined, remotes: string[], label: string): string | undefined {
	if (!value) return undefined;
	if (value === ".") {
		throw new Error(`The selected ${label} is local. Pass a full GitHub pull request URL.`);
	}
	if (!remotes.includes(value)) {
		throw new Error(`The selected ${label} doesn't match a configured Git remote. Pass a full GitHub pull request URL.`);
	}
	return value;
}

export async function resolveRepositoryContext(
	cwd: string,
	options: { requireBranch: boolean; runner?: GitRunner },
): Promise<RepositoryContext> {
	const runner = options.runner ?? runGit;
	const root = await optionalGit(runner, ["rev-parse", "--show-toplevel"], cwd);
	if (!root) throw new Error("Run /review from inside a Git repository.");

	const branch = await optionalGit(runner, ["symbolic-ref", "--quiet", "--short", "HEAD"], root);
	if (options.requireBranch && !branch) {
		throw new Error("The repository is in detached HEAD state. Pass a pull request number or URL.");
	}

	const remotesOutput = await optionalGit(runner, ["remote"], root);
	const remotes = [...new Set((remotesOutput ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
	if (remotes.length === 0) throw new Error("The repository has no Git remote.");

	let selected: string | undefined;
	if (branch) {
		selected = configuredRemote(
			await optionalGit(runner, ["config", "--get", `branch.${branch}.pushRemote`], root),
			remotes,
			"branch push remote",
		);
	}
	if (!selected) {
		selected = configuredRemote(
			await optionalGit(runner, ["config", "--get", "remote.pushDefault"], root),
			remotes,
			"default push remote",
		);
	}
	if (!selected && branch) {
		selected = configuredRemote(
			await optionalGit(runner, ["config", "--get", `branch.${branch}.remote`], root),
			remotes,
			"branch tracking remote",
		);
	}
	if (!selected && remotes.includes("origin")) selected = "origin";
	if (!selected && remotes.length === 1) selected = remotes[0];
	if (!selected) throw new Error("The repository has multiple remotes. Pass a full GitHub pull request URL.");

	return { repository: parseGitHubRemote(await remoteUrl(runner, root, selected)), branch };
}
