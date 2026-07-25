import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { createInterface } from "node:readline";

import { complete, contentText, type UserMessage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);
const MAX_TITLE_INPUT_CHARS = 1_200;
const TITLE_MAX_TOKENS = 32;
const STOP_WORDS = new Set([
	"le", "la", "les", "un", "une", "des", "de", "du", "d", "dans", "sur", "pour", "par", "avec",
	"et", "ou", "est", "ce", "ça", "ca", "que", "qui", "quoi", "quand", "comment", "possible",
	"je", "tu", "il", "elle", "on", "nous", "vous", "ils", "elles", "mon", "ma", "mes", "ton", "ta", "tes",
	"faire", "fait", "peux", "peut", "veux", "souhaite", "voudrais", "svp", "stp",
	"the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "is", "are", "can", "could",
]);

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.filter((part): part is { type: "text"; text: string } => (
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		))
		.map((part) => part.text)
		.join(" ");
}

export function cleanPrompt(prompt: string): string {
	return prompt
		.replace(/```[\s\S]*?```/g, " code ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/^#+\s*/gm, "")
		.replace(/[\r\n\t]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function shortenTitle(title: string, maxLength = 32): string {
	if (title.length <= maxLength) return title;

	const prefix = title.slice(0, maxLength);
	const wordBoundary = prefix.lastIndexOf(" ");
	const shortened = wordBoundary >= Math.floor(maxLength / 2)
		? prefix.slice(0, wordBoundary)
		: title.slice(0, maxLength - 1);
	return `${shortened.trimEnd()}…`;
}

export function fallbackSummary(prompt: string): string {
	const cleaned = cleanPrompt(prompt).toLowerCase();
	if (!cleaned) return "session";

	const keywords = cleaned
		.replace(/[^\p{L}\p{N}._/-]+/gu, " ")
		.split(" ")
		.filter((word) => word.length > 2 && !STOP_WORDS.has(word))
		.slice(0, 4);

	const summary = keywords.length ? keywords.join(" ") : cleaned.split(" ").slice(0, 4).join(" ");
	return shortenTitle(summary);
}

export function normalizeGeneratedTitle(value: string): string | undefined {
	const title = value
		.split(/\r?\n/, 1)[0]
		?.replace(/^#+\s*/, "")
		.replace(/^(?:titre|title)\s*:\s*/i, "")
		.replace(/^[\s'"`*_–—-]+|[\s'"`*_.,:;!?–—-]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (!title) return undefined;
	return shortenTitle(title);
}

export function safeTitle(title: string): string | undefined {
	const safe = title.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
	return safe || undefined;
}

async function waitForSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason;

	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

async function llmSummary(prompt: string, ctx: ExtensionContext, parentSignal?: AbortSignal): Promise<string | undefined> {
	if (!ctx.model) return undefined;

	const signal = parentSignal
		? AbortSignal.any([parentSignal, AbortSignal.timeout(4_000)])
		: AbortSignal.timeout(4_000);

	try {
		const auth = await waitForSignal(ctx.modelRegistry.getApiKeyAndHeaders(ctx.model), signal);
		if (!auth.ok) return undefined;

		const message: UserMessage = {
			role: "user",
			content: [{ type: "text", text: cleanPrompt(prompt).slice(0, MAX_TITLE_INPUT_CHARS) }],
			timestamp: Date.now(),
		};
		const response = await complete(
			ctx.model,
			{
				systemPrompt:
					"Résume le prompt utilisateur en un titre d'onglet terminal ultra court. " +
					"Réponds uniquement avec 2 à 4 mots, en français si possible, sans ponctuation, " +
					"sans guillemets et sans préfixe.",
				messages: [message],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				maxTokens: TITLE_MAX_TOKENS,
				env: auth.env,
				reasoningEffort: ctx.model.reasoning ? "minimal" : undefined,
				signal,
			},
		);

		return normalizeGeneratedTitle(contentText(response.content, " "));
	} catch {
		return undefined;
	}
}

async function summarizePrompt(prompt: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<string> {
	return (await llmSummary(prompt, ctx, signal)) ?? fallbackSummary(prompt);
}

function setTerminalTitle(title: string, ctx: ExtensionContext): void {
	const safe = safeTitle(title);
	if (safe && ctx.mode === "tui") ctx.ui.setTitle(safe);
}

async function resetHerdrTabTitle(signal: AbortSignal): Promise<void> {
	if (signal.aborted || process.env.HERDR_ENV !== "1" || !process.env.HERDR_TAB_ID) return;

	try {
		const { stdout } = await execFileAsync("herdr", ["tab", "get", process.env.HERDR_TAB_ID], {
			encoding: "utf8",
			signal,
			timeout: 1_000,
		});
		const response = JSON.parse(stdout) as { result?: { tab?: { number?: number } } };
		const number = response.result?.tab?.number;
		if (typeof number !== "number") return;

		await execFileAsync("herdr", ["tab", "rename", process.env.HERDR_TAB_ID, String(number)], {
			signal,
			timeout: 1_000,
		});
	} catch {
		// Herdr integration is optional and must never interrupt Pi.
	}
}

async function updateTerminalHosts(title: string, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;

	const updates: Array<Promise<unknown>> = [];
	if (process.env.HERDR_ENV === "1" && process.env.HERDR_TAB_ID) {
		updates.push(execFileAsync("herdr", ["tab", "rename", process.env.HERDR_TAB_ID, title], {
			signal,
			timeout: 1_000,
		}));
	}
	if (process.env.TMUX) {
		updates.push(execFileAsync("tmux", ["rename-window", title], { signal, timeout: 500 }));
	}

	await Promise.allSettled(updates);
}

function conversationText(ctx: ExtensionContext): string | undefined {
	const messages: string[] = [];
	let length = 0;
	const branch = ctx.sessionManager.getBranch();

	for (let index = branch.length - 1; index >= 0 && length < MAX_TITLE_INPUT_CHARS; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const text = textFromContent(message.content);
		if (!text.trim()) continue;

		const formatted = `${message.role}: ${cleanPrompt(text)}`;
		messages.push(formatted);
		length += formatted.length + (messages.length > 1 ? 1 : 0);
	}

	const joined = messages.join("\n");
	if (!joined) return undefined;
	return joined.slice(0, MAX_TITLE_INPUT_CHARS);
}

export async function firstUserPromptFromSession(file: string | undefined): Promise<string | undefined> {
	if (!file) return undefined;

	const input = createReadStream(file, { encoding: "utf8" });
	const lines = createInterface({ input, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			if (!line.trim()) continue;

			try {
				const entry = JSON.parse(line) as {
					type?: unknown;
					message?: { role?: unknown; content?: unknown };
				};
				if (entry.type !== "message" || entry.message?.role !== "user") continue;

				const text = textFromContent(entry.message.content);
				if (text.trim()) return text;
			} catch {
				// Session parsing follows Pi's fail-soft behavior for malformed JSONL lines.
			}
		}
	} catch {
		// Missing or unreadable session files fall back to the next real prompt.
	} finally {
		lines.close();
		input.destroy();
	}

	return undefined;
}

export default function sessionTitleExtension(pi: ExtensionAPI): void {
	let generationToken = 0;
	let generationController: AbortController | undefined;
	let generationPending = false;
	const hostController = new AbortController();
	let hostUpdateQueue = Promise.resolve();

	const enqueueHostUpdate = (update: (signal: AbortSignal) => Promise<void>): void => {
		const run = () => hostController.signal.aborted ? Promise.resolve() : update(hostController.signal);
		hostUpdateQueue = hostUpdateQueue.then(run, run);
	};

	const applySessionTitle = (title: string, ctx: ExtensionContext): void => {
		const safe = safeTitle(title);
		if (!safe) return;

		setTerminalTitle(safe, ctx);
		if (ctx.mode === "tui") enqueueHostUpdate((signal) => updateTerminalHosts(safe, signal));
	};

	const cancelGeneration = (): void => {
		generationToken += 1;
		generationController?.abort();
		generationController = undefined;
		generationPending = false;
	};

	const setSharedTitle = (title: string, ctx: ExtensionContext): void => {
		const normalized = safeTitle(title)?.slice(0, 80).trimEnd();
		if (!normalized) return;

		if (pi.getSessionName() === normalized) {
			applySessionTitle(normalized, ctx);
			return;
		}

		pi.setSessionName(normalized);
	};

	const generateInBackground = (prompt: string, ctx: ExtensionContext): void => {
		if (generationPending || pi.getSessionName()) return;

		generationPending = true;
		const token = ++generationToken;
		const controller = new AbortController();
		generationController = controller;

		void summarizePrompt(prompt, ctx, controller.signal)
			.then((summary) => {
				if (token !== generationToken || controller.signal.aborted || pi.getSessionName()) return;
				setSharedTitle(`π ${summary}`, ctx);
			})
			.finally(() => {
				if (token !== generationToken) return;
				generationPending = false;
				generationController = undefined;
			});
	};

	pi.on("input", async (event, ctx) => {
		if (event.source !== "extension") generateInBackground(event.text, ctx);
	});

	pi.registerCommand("rename", {
		description: "Renommer la session et l'onglet (sans titre : génération IA)",
		handler: async (args, ctx) => {
			cancelGeneration();
			const manualTitle = args.trim();

			if (manualTitle) {
				setSharedTitle(manualTitle, ctx);
				ctx.ui.notify(`Session et onglet renommés : ${safeTitle(manualTitle)?.slice(0, 80)}`, "info");
				return;
			}

			const context = conversationText(ctx);
			if (!context) {
				ctx.ui.notify("Aucun contexte disponible pour générer un nom", "warning");
				return;
			}

			const token = generationToken;
			const generatedTitle = `π ${await summarizePrompt(context, ctx)}`;
			if (token !== generationToken) return;

			setSharedTitle(generatedTitle, ctx);
			ctx.ui.notify(`Session et onglet renommés par l'IA : ${generatedTitle}`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		cancelGeneration();
		if (event.reason === "new" && ctx.mode === "tui") enqueueHostUpdate(resetHerdrTabTitle);

		const existingName = pi.getSessionName();
		if (existingName) {
			applySessionTitle(existingName, ctx);
			return;
		}

		setTerminalTitle("π nouvelle session", ctx);
		const token = generationToken;
		void firstUserPromptFromSession(ctx.sessionManager.getSessionFile() ?? undefined).then((prompt) => {
			if (token === generationToken && prompt) generateInBackground(prompt, ctx);
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		generateInBackground(event.prompt, ctx);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		cancelGeneration();
		if (event.name) applySessionTitle(event.name, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		cancelGeneration();
		hostController.abort();
		await hostUpdateQueue.catch(() => undefined);
		if (process.env.HERDR_ENV !== "1") setTerminalTitle("kitty", ctx);
	});
}
