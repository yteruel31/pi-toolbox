import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { complete } from "@earendil-works/pi-ai/compat";
import type { Context, Message, Model } from "@earendil-works/pi-ai";

const MAX_MESSAGES = 32, MAX_CONTENT = 64_000, MAX_SYSTEM = 16_000, MAX_TOKENS = 8_192;
function reject(): never { throw new Error("MCP sampling request was rejected"); }
function boundedJson(value: unknown, max: number): boolean {
	try { return Buffer.byteLength(JSON.stringify(value)) <= max; } catch { return false; }
}
function preview(value: string, max = 1_000): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, max);
}
function textOf(content: unknown): string {
	const parts = Array.isArray(content) ? content : [content];
	let text = "";
	for (const part of parts) {
		if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text" || typeof (part as { text?: unknown }).text !== "string") reject();
		text += (text ? "\n" : "") + (part as { text: string }).text;
	}
	if (text.length > MAX_CONTENT) reject(); return text;
}
function selectModel(ctx: ExtensionContext, params: Record<string, unknown>): Model<any> {
	if (ctx.model && ctx.modelRegistry.hasConfiguredAuth(ctx.model)) return ctx.model;
	const available = ctx.modelRegistry.getAvailable().filter((m) => ctx.modelRegistry.hasConfiguredAuth(m)).slice(0, 100);
	const hints = (params.modelPreferences as { hints?: Array<{ name?: string }> } | undefined)?.hints?.slice(0, 10) ?? [];
	for (const hint of hints) { const name = hint.name?.toLowerCase(); const found = name && available.find((m) => m.id.toLowerCase() === name || `${m.provider}/${m.id}`.toLowerCase() === name); if (found) return found; }
	if (available[0]) return available[0]; reject();
}
export async function sample(
	server: string,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
	autoApprove: boolean,
	requestSignal?: AbortSignal,
	completeFn: typeof complete = complete,
): Promise<Record<string, unknown>> {
	if (requestSignal?.aborted || ctx.signal?.aborted || !Array.isArray(params.messages) || params.messages.length < 1 || params.messages.length > MAX_MESSAGES || params.tools !== undefined || params.toolChoice !== undefined || params.stopSequences !== undefined || params.task !== undefined || (params.includeContext !== undefined && params.includeContext !== "none")) reject();
	if (params.systemPrompt !== undefined && (typeof params.systemPrompt !== "string" || params.systemPrompt.length > MAX_SYSTEM)) reject();
	if (typeof params.maxTokens !== "number" || !Number.isInteger(params.maxTokens) || params.maxTokens < 1 || params.maxTokens > MAX_TOKENS || params.metadata !== undefined && !boundedJson(params.metadata, 8_192) || params.temperature !== undefined && (typeof params.temperature !== "number" || !Number.isFinite(params.temperature) || params.temperature < 0 || params.temperature > 2)) reject();
	let aggregateContent = 0;
	const previews: string[] = [];
	const messages: Message[] = params.messages.map((raw) => {
		if (!raw || typeof raw !== "object" || !["user", "assistant"].includes((raw as { role?: string }).role ?? "")) reject();
		const role = (raw as { role: "user" | "assistant" }).role, text = textOf((raw as { content: unknown }).content);
		aggregateContent += text.length;
		if (aggregateContent > MAX_CONTENT) reject();
		previews.push(`${role}: ${preview(text, 500)}`);
		if (role === "user") return { role, content: text, timestamp: Date.now() };
		return { role, content: [{ type: "text", text }], api: "openai-completions", provider: "mcp", model: "server-context", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() } as Message;
	});
	const requestPreview = [
		`Allow this server to send ${messages.length} message(s) to the current model?`,
		...(typeof params.systemPrompt === "string" ? [`System: ${preview(params.systemPrompt)}`] : []),
		...previews.slice(0, 8),
	].join("\n\n");
	if (!autoApprove && !await ctx.ui.confirm(`MCP sampling — ${server}`, requestPreview, { signal: requestSignal })) reject();
	const model = selectModel(ctx, params);
	const signal = requestSignal ?? ctx.signal;
	let response: Awaited<ReturnType<typeof complete>>;
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model); if (!auth.ok) reject();
		response = await completeFn(model, { systemPrompt: params.systemPrompt as string | undefined, messages } as Context, { apiKey: auth.apiKey, headers: auth.headers, maxTokens: params.maxTokens, temperature: params.temperature as number | undefined, signal });
	} catch { reject(); }
	if (signal?.aborted || response.stopReason === "error" || response.stopReason === "aborted") reject();
	if (response.stopReason === "toolUse" || response.content.some((item) => item.type !== "text" && item.type !== "thinking")) reject();
	const text = response.content.filter((x): x is { type: "text"; text: string } => x.type === "text").map((x) => x.text).join("");
	if (!text || text.length > MAX_CONTENT) reject();
	if (!autoApprove && !await ctx.ui.confirm(`MCP sampling result — ${server}`, `Return this response to the server?\n\n${preview(text)}`, { signal: requestSignal })) reject();
	return { role: "assistant", content: { type: "text", text }, model: `${model.provider}/${model.id}`, stopReason: response.stopReason === "length" ? "maxTokens" : "endTurn" };
}
