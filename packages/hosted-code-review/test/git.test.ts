import assert from "node:assert/strict";
import test from "node:test";

import { resolveRepositoryContext, type GitRunner } from "../src/git.js";

function fixture(values: Record<string, string | Error>): { runner: GitRunner; calls: Array<{ args: string[]; cwd: string }> } {
	const calls: Array<{ args: string[]; cwd: string }> = [];
	return {
		calls,
		runner: async (args, cwd) => {
			calls.push({ args, cwd });
			const value = values[args.join(" ")];
			if (value instanceof Error || value === undefined) throw value ?? new Error("missing fixture");
			return value;
		},
	};
}

test("uses ctx cwd, repository root, and the current branch tracking remote", async () => {
	const subject = fixture({
		"rev-parse --show-toplevel": "/repo",
		"symbolic-ref --quiet --short HEAD": "feature/review",
		remote: "origin\nupstream",
		"config --get branch.feature/review.pushRemote": new Error("unset"),
		"config --get remote.pushDefault": new Error("unset"),
		"config --get branch.feature/review.remote": "upstream",
		"remote get-url --push upstream": "git@github.com:fork/app.git",
	});
	assert.deepEqual(await resolveRepositoryContext("/nested", { requireBranch: true, runner: subject.runner }), {
		repository: { host: "github.com", owner: "fork", repo: "app" }, branch: "feature/review",
	});
	assert.deepEqual(subject.calls[0], { args: ["rev-parse", "--show-toplevel"], cwd: "/nested" });
	assert.ok(subject.calls.slice(1).every(({ cwd }) => cwd === "/repo"));
});

test("prefers the branch push remote in a triangular fork workflow", async () => {
	const subject = fixture({
		"rev-parse --show-toplevel": "/repo",
		"symbolic-ref --quiet --short HEAD": "feature/review",
		remote: "origin\nupstream",
		"config --get branch.feature/review.pushRemote": "origin",
		"remote get-url --push origin": "git@github.com:fork/app.git",
	});
	assert.deepEqual(await resolveRepositoryContext("/repo", { requireBranch: true, runner: subject.runner }), {
		repository: { host: "github.com", owner: "fork", repo: "app" }, branch: "feature/review",
	});
	assert.equal(subject.calls.some(({ args }) => args.join(" ") === "config --get branch.feature/review.remote"), false);
});

test("uses remote.pushDefault before the branch tracking remote", async () => {
	const subject = fixture({
		"rev-parse --show-toplevel": "/repo",
		"symbolic-ref --quiet --short HEAD": "feature/review",
		remote: "fork\nupstream",
		"config --get branch.feature/review.pushRemote": new Error("unset"),
		"config --get remote.pushDefault": "fork",
		"remote get-url --push fork": "https://github.com/contributor/app.git",
	});
	assert.equal(
		(await resolveRepositoryContext("/repo", { requireBranch: false, runner: subject.runner })).repository.owner,
		"contributor",
	);
});

test("uses a sole non-origin remote as the fallback", async () => {
	const subject = fixture({
		"rev-parse --show-toplevel": "/repo", "symbolic-ref --quiet --short HEAD": new Error("detached"), remote: "upstream",
		"remote get-url --push upstream": "https://github.com/sole/repo.git",
	});
	assert.equal((await resolveRepositoryContext("/repo", { requireBranch: false, runner: subject.runner })).repository.owner, "sole");
});

test("prefers origin and fails closed on ambiguity", async () => {
	const origin = fixture({
		"rev-parse --show-toplevel": "/repo", "symbolic-ref --quiet --short HEAD": new Error("detached"), remote: "upstream\norigin",
		"remote get-url --push origin": "https://github.com/org/repo.git",
	});
	assert.equal((await resolveRepositoryContext("/repo", { requireBranch: false, runner: origin.runner })).repository.owner, "org");

	const ambiguous = fixture({
		"rev-parse --show-toplevel": "/repo", "symbolic-ref --quiet --short HEAD": new Error("detached"), remote: "fork\nupstream",
	});
	await assert.rejects(resolveRepositoryContext("/repo", { requireBranch: false, runner: ambiguous.runner }), /multiple remotes/);
});

test("fails closed for local and unknown configured push destinations", async () => {
	for (const configured of [".", "missing"]) {
		const subject = fixture({
			"rev-parse --show-toplevel": "/repo",
			"symbolic-ref --quiet --short HEAD": "feature/review",
			remote: "origin\nupstream",
			"config --get branch.feature/review.pushRemote": configured,
		});
		await assert.rejects(
			resolveRepositoryContext("/repo", { requireBranch: true, runner: subject.runner }),
			/full GitHub pull request URL/,
		);
	}
});

test("reports no repository, no remote, and detached branch without leaking subprocess errors", async () => {
	const secret = "TOP_SECRET_SENTINEL";
	const missing = fixture({ "rev-parse --show-toplevel": new Error(secret) });
	await assert.rejects(resolveRepositoryContext("/tmp", { requireBranch: false, runner: missing.runner }), (error: Error) => {
		assert.doesNotMatch(error.message, new RegExp(secret));
		return /Git repository/.test(error.message);
	});

	const detached = fixture({
		"rev-parse --show-toplevel": "/repo", "symbolic-ref --quiet --short HEAD": new Error(secret),
	});
	await assert.rejects(resolveRepositoryContext("/repo", { requireBranch: true, runner: detached.runner }), /detached HEAD/);
});
