import assert from "node:assert/strict";
import test from "node:test";

import {
	branchBootstrapUrl,
	encodeBranch,
	hostedReviewOrigin,
	parseGitHubRemote,
	parsePullRequestUrl,
	pullBootstrapUrl,
	validateBootstrapUrl,
} from "../src/urls.js";

const origin = hostedReviewOrigin("https://review.example.test");

test("normalizes supported GitHub remotes without exposing raw URLs", () => {
	const expected = { host: "github.com", owner: "gigapay", repo: "app" };
	assert.deepEqual(parseGitHubRemote("https://github.com/gigapay/app.git"), expected);
	assert.deepEqual(parseGitHubRemote("git@github.com:gigapay/app.git"), expected);
	assert.deepEqual(parseGitHubRemote("ssh://git@github.com/gigapay/app.git"), expected);
});

test("rejects credential-bearing and unsupported remotes", () => {
	for (const remote of [
		"https://TOKEN@github.com/gigapay/app.git",
		"https://user:TOKEN@github.com/gigapay/app.git",
		"ssh://TOKEN@github.com/gigapay/app.git",
		"https://gitlab.com/gigapay/app.git",
		"git@github.com:gigapay/app/extra.git",
	]) assert.throws(() => parseGitHubRemote(remote), /remote|credentials|GitHub/);
});

test("parses only clean full GitHub pull request URLs", () => {
	assert.deepEqual(parsePullRequestUrl("https://github.com/gigapay/app/pull/42"), {
		host: "github.com", owner: "gigapay", repo: "app", number: 42,
	});
	for (const value of [
		"http://github.com/gigapay/app/pull/42",
		"https://TOKEN@github.com/gigapay/app/pull/42",
		"https://github.com/gigapay/app/pull/0",
		"https://github.com/gigapay/app/pull/42?token=SECRET",
		"https://github.com/gigapay/app/issues/42",
	]) assert.throws(() => parsePullRequestUrl(value));
});

test("builds exact pull and base64url branch bootstrap paths", () => {
	assert.equal(
		pullBootstrapUrl(origin, { host: "github.com", owner: "gigapay", repo: "app", number: 42 }),
		"https://review.example.test/open/github/gigapay/app/pull/42",
	);
	const branch = "yoann/fix é";
	assert.equal(encodeBranch(branch), Buffer.from(branch, "utf8").toString("base64url"));
	assert.equal(
		branchBootstrapUrl(origin, { host: "github.com", owner: "gigapay", repo: "app" }, branch),
		`https://review.example.test/open/github/gigapay/app/branch/${Buffer.from(branch, "utf8").toString("base64url")}`,
	);
});

test("accepts only the exact configured HTTPS origin and safe bootstrap paths", () => {
	assert.equal(
		validateBootstrapUrl("https://review.example.test/open/github/gigapay/app/pull/42", origin),
		"https://review.example.test/open/github/gigapay/app/pull/42",
	);
	for (const value of [
		"https://evil.example/open/github/gigapay/app/pull/42",
		"https://user:pass@review.example.test/open/github/gigapay/app/pull/42",
		"https://review.example.test/open/github/gigapay/app/pull/42?secret=x",
		"https://review.example.test/open/github/gigapay/app/pull/../42",
		"https://review.example.test/open/github/gigapay/app/branch/a%2Fb",
	]) assert.throws(() => validateBootstrapUrl(value, origin));
	for (const configured of ["http://review.example.test", "https://user@review.example.test", "https://review.example.test/path", "https://review.example.test?x=1"]) {
		assert.throws(() => hostedReviewOrigin(configured));
	}
});
