import assert from "node:assert/strict";
import test from "node:test";

import { registerReviewCommand } from "../src/command.js";
import type { GitRunner } from "../src/git.js";

interface Notice { message: string; level: string }

function harness(options: { git?: Record<string, string | Error>; openError?: Error; mode?: "tui" | "json"; secret?: string } = {}) {
	let handler: ((args: string, ctx: any) => Promise<void>) | undefined;
	const opened: string[] = [];
	const notices: Notice[] = [];
	const gitCalls: string[] = [];
	const runner: GitRunner = async (args) => {
		gitCalls.push(args.join(" "));
		const value = options.git?.[args.join(" ")];
		if (value instanceof Error || value === undefined) throw value ?? new Error(options.secret ?? "unexpected git call");
		return value;
	};
	registerReviewCommand({
		registerCommand(name: string, command: { handler: typeof handler }) {
			assert.equal(name, "review");
			handler = command.handler;
		},
	} as never, {
		gitRunner: runner,
		environment: { PI_HOSTED_REVIEW_URL: "https://review.example.test", REVIEW_SECRET: options.secret },
		open: async (url) => { opened.push(url); if (options.openError) throw options.openError; },
	});
	return {
		opened, notices, gitCalls,
		run: async (args: string) => {
			assert.ok(handler);
			await handler(args, { cwd: "/work/repo", mode: options.mode ?? "tui", ui: { notify(message: string, level: string) { notices.push({ message, level }); } } });
		},
	};
}

const repositoryGit = {
	"rev-parse --show-toplevel": "/work/repo",
	"symbolic-ref --quiet --short HEAD": "feature/review",
	remote: "origin",
	"config --get branch.feature/review.remote": "origin",
	"remote get-url --push origin": "git@github.com:gigapay/app.git",
};

test("opens an explicit full pull request URL without reading local Git metadata", async () => {
	const subject = harness();
	await subject.run("https://github.com/gigapay/app/pull/42");
	assert.deepEqual(subject.opened, ["https://review.example.test/open/github/gigapay/app/pull/42"]);
	assert.deepEqual(subject.gitCalls, []);
});

test("combines an explicit pull request number with the canonical current repository", async () => {
	const subject = harness({ git: repositoryGit });
	await subject.run("42");
	assert.deepEqual(subject.opened, ["https://review.example.test/open/github/gigapay/app/pull/42"]);
});

test("uses the base64url branch bootstrap route with no arguments", async () => {
	const subject = harness({ git: repositoryGit });
	await subject.run("");
	assert.deepEqual(subject.opened, [
		`https://review.example.test/open/github/gigapay/app/branch/${Buffer.from("feature/review").toString("base64url")}`,
	]);
});

test("rejects malformed input and detached no-argument invocation", async () => {
	for (const input of ["0", "-1", "not-a-number", "42 extra", "https://github.com/gigapay/app/issues/42"]) {
		const subject = harness({ git: repositoryGit });
		await subject.run(input);
		assert.deepEqual(subject.opened, []);
		assert.equal(subject.notices.at(-1)?.level, "error");
	}
	const detached = harness({ git: { ...repositoryGit, "symbolic-ref --quiet --short HEAD": new Error("detached") } });
	await detached.run("");
	assert.deepEqual(detached.opened, []);
	assert.match(detached.notices[0]?.message ?? "", /detached HEAD/);
});

test("returns a clean copyable URL in headless mode or when browser opening fails", async () => {
	const headless = harness({ mode: "json" });
	await headless.run("https://github.com/gigapay/app/pull/42");
	assert.deepEqual(headless.opened, []);
	assert.match(headless.notices[0]?.message ?? "", /^Open this review URL in a browser: https:\/\//);

	const failed = harness({ openError: new Error("BROWSER_SECRET") });
	await failed.run("https://github.com/gigapay/app/pull/42");
	assert.match(failed.notices[0]?.message ?? "", /Open this URL manually/);
	assert.doesNotMatch(JSON.stringify(failed.notices), /BROWSER_SECRET/);
});

test("redacts internal and environment secret sentinels", async () => {
	const secret = "TOP_SECRET_SENTINEL";
	const subject = harness({ secret, git: { "rev-parse --show-toplevel": new Error(secret) } });
	await subject.run("42");
	assert.doesNotMatch(JSON.stringify(subject.notices), new RegExp(secret));
	assert.deepEqual(subject.opened, []);
});
