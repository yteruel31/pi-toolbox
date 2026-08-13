import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { openBrowser } from "./browser.js";
import { resolveRepositoryContext, type GitRunner } from "./git.js";
import {
	branchBootstrapUrl,
	hostedReviewOrigin,
	parsePullRequestUrl,
	pullBootstrapUrl,
	type PullRequestTarget,
} from "./urls.js";

export interface ReviewCommandDependencies {
	open?: (url: string) => Promise<void>;
	gitRunner?: GitRunner;
	environment?: NodeJS.ProcessEnv;
}

function parsePositiveNumber(value: string): number | undefined {
	if (!/^[1-9]\d*$/.test(value)) return undefined;
	const number = Number(value);
	return Number.isSafeInteger(number) ? number : undefined;
}

function safeError(error: unknown): string {
	if (error instanceof Error && [
		"PI_HOSTED_REVIEW_URL must",
		"Pass a positive",
		"The pull request URL",
		"The GitHub pull request URL",
		"The pull request number",
		"Run /review",
		"The repository",
		"The current branch",
		"The selected",
	].some((prefix) => error.message.startsWith(prefix))) return error.message;
	return "The review couldn't be opened. Pass a full GitHub pull request URL or pull request number and try again.";
}

async function targetUrl(args: string, ctx: ExtensionContext, dependencies: ReviewCommandDependencies): Promise<string> {
	const value = args.trim();
	if (/\s/.test(value)) throw new Error("Pass a positive pull request number or a full HTTPS GitHub pull request URL.");
	const origin = hostedReviewOrigin(dependencies.environment?.PI_HOSTED_REVIEW_URL);

	if (value.startsWith("https://")) return pullBootstrapUrl(origin, parsePullRequestUrl(value));
	if (value) {
		const number = parsePositiveNumber(value);
		if (!number) throw new Error("Pass a positive pull request number or a full HTTPS GitHub pull request URL.");
		const { repository } = await resolveRepositoryContext(ctx.cwd, { requireBranch: false, runner: dependencies.gitRunner });
		return pullBootstrapUrl(origin, { ...repository, number } satisfies PullRequestTarget);
	}

	const { repository, branch } = await resolveRepositoryContext(ctx.cwd, { requireBranch: true, runner: dependencies.gitRunner });
	return branchBootstrapUrl(origin, repository, branch!);
}

export function registerReviewCommand(pi: ExtensionAPI, dependencies: ReviewCommandDependencies = {}): void {
	pi.registerCommand("review", {
		description: "Open the current GitHub pull request in hosted Plannotator",
		handler: async (args, ctx) => {
			try {
				const url = await targetUrl(args, ctx, dependencies);
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`Open this review URL in a browser: ${url}`, "info");
					return;
				}
				try {
					await (dependencies.open ?? openBrowser)(url);
					ctx.ui.notify("Opened the pull request in hosted Plannotator.", "info");
				} catch {
					ctx.ui.notify(`The browser couldn't be opened. Open this URL manually: ${url}`, "warning");
				}
			} catch (error) {
				ctx.ui.notify(safeError(error), "error");
			}
		},
	});
}
