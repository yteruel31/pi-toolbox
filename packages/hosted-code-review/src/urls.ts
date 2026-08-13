const DEFAULT_HOSTED_REVIEW_ORIGIN = "https://review.yoann.gigapay.dev";
const GITHUB_HOST = "github.com";
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface GitHubRepository {
	host: typeof GITHUB_HOST;
	owner: string;
	repo: string;
}

export interface PullRequestTarget extends GitHubRepository {
	number: number;
}

export function hostedReviewOrigin(value = process.env.PI_HOSTED_REVIEW_URL): URL {
	const raw = value?.trim() || DEFAULT_HOSTED_REVIEW_ORIGIN;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("PI_HOSTED_REVIEW_URL must be a valid HTTPS origin.");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/"
	) {
		throw new Error("PI_HOSTED_REVIEW_URL must be a clean HTTPS origin without credentials, a path, query, or fragment.");
	}
	return url;
}

function repositoryPart(value: string, label: string): string {
	if (!REPOSITORY_PART.test(value) || value === "." || value === "..") {
		throw new Error(`The GitHub ${label} is invalid.`);
	}
	return value;
}

export function parseGitHubRemote(remote: string): GitHubRepository {
	const value = remote.trim();
	let owner: string;
	let repo: string;

	const scp = /^git@github\.com:([^/]+)\/([^/]+)$/.exec(value);
	if (scp) {
		owner = scp[1]!;
		repo = scp[2]!;
	} else {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw new Error("The selected remote isn't a supported github.com URL.");
		}
		if (!(["https:", "ssh:"] as string[]).includes(url.protocol) || url.hostname.toLowerCase() !== GITHUB_HOST || url.port) {
			throw new Error("The selected remote isn't a supported github.com URL.");
		}
		if (url.password || (url.protocol === "https:" && url.username) || (url.protocol === "ssh:" && url.username !== "git")) {
			throw new Error("The selected GitHub remote contains unsupported credentials.");
		}
		if (url.search || url.hash) throw new Error("The selected remote isn't a clean GitHub repository URL.");
		const parts = url.pathname.replace(/^\//, "").replace(/\/$/, "").split("/");
		if (parts.length !== 2) throw new Error("The selected remote isn't a GitHub owner/repository URL.");
		[owner, repo] = parts as [string, string];
	}

	repo = repo.replace(/\.git$/, "");
	return { host: GITHUB_HOST, owner: repositoryPart(owner, "owner"), repo: repositoryPart(repo, "repository") };
}

export function parsePullRequestUrl(value: string): PullRequestTarget {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Pass a positive pull request number or a full HTTPS GitHub pull request URL.");
	}
	if (
		url.protocol !== "https:" ||
		url.hostname.toLowerCase() !== GITHUB_HOST ||
		url.port ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("The pull request URL must be a clean HTTPS github.com URL.");
	}
	const match = /^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
	if (!match) throw new Error("The GitHub pull request URL must end with /owner/repository/pull/number.");
	const number = Number(match[3]);
	if (!Number.isSafeInteger(number)) throw new Error("The pull request number is too large.");
	return {
		host: GITHUB_HOST,
		owner: repositoryPart(decodeURIComponent(match[1]!), "owner"),
		repo: repositoryPart(decodeURIComponent(match[2]!), "repository"),
		number,
	};
}

export function encodeBranch(branch: string): string {
	if (!branch || branch.includes("\0")) throw new Error("The current Git branch is invalid.");
	return Buffer.from(branch, "utf8").toString("base64url");
}

function safeRepositorySegment(value: string): string {
	return encodeURIComponent(repositoryPart(value, "path segment"));
}

export function pullBootstrapUrl(origin: URL, target: PullRequestTarget): string {
	return validateBootstrapUrl(
		`${origin.origin}/open/github/${safeRepositorySegment(target.owner)}/${safeRepositorySegment(target.repo)}/pull/${target.number}`,
		origin,
	);
}

export function branchBootstrapUrl(origin: URL, repository: GitHubRepository, branch: string): string {
	return validateBootstrapUrl(
		`${origin.origin}/open/github/${safeRepositorySegment(repository.owner)}/${safeRepositorySegment(repository.repo)}/branch/${encodeBranch(branch)}`,
		origin,
	);
}

export function validateBootstrapUrl(value: string, origin: URL): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("The review URL is invalid.");
	}
	if (url.protocol !== "https:" || url.origin !== origin.origin || url.username || url.password || url.search || url.hash) {
		throw new Error("The review URL doesn't match the configured HTTPS origin.");
	}
	const match = /^\/open\/github\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(pull\/([1-9]\d*)|branch\/([A-Za-z0-9_-]+))$/.exec(url.pathname);
	if (!match || (!match[4] && (!match[5] || !BASE64URL.test(match[5])))) {
		throw new Error("The review URL has an unsafe bootstrap path.");
	}
	return url.href;
}
