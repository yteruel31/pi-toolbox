import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEFAULT_UI_SETTINGS, type McpConfig } from "./config.js";
import { parseServerConfigs } from "./mcp/config.js";
import { McpServerManager } from "./mcp/manager.js";
import { OAuthCoordinator } from "./auth/coordinator.js";
import { OAuthStore } from "./auth/store.js";
import { StoredOAuthProvider } from "./auth/provider.js";
import { GatewayClient } from "./gateway/client.js";
import { CustomGatewayExposure, TailscaleGatewayExposure, type GatewayExposure } from "./gateway/exposure.js";
import { TailscaleAdapter } from "./tailscale.js";
import { McpAppController } from "./apps/controller.js";
import { AppPublisher, type AppPublicationStatus } from "./apps/publisher.js";
import { sample } from "./mcp/sampling.js";
import { elicitForm } from "./mcp/elicitation.js";

const Params = Type.Object({
	server: Type.Optional(Type.String({ maxLength: 64 })),
	search: Type.Optional(Type.String({ maxLength: 500 })),
	connect: Type.Optional(Type.String({ maxLength: 64 })),
	tool: Type.Optional(Type.String({ maxLength: 500 })),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	action: Type.Optional(Type.Union([
		Type.Literal("auth-start"), Type.Literal("auth-complete"),
		Type.Literal("resources-list"), Type.Literal("resources-read"),
		Type.Literal("prompts-list"), Type.Literal("prompts-get"), Type.Literal("diagnostics"),
	])),
}, { additionalProperties: false });
type Input = Static<typeof Params>;
type Details = Record<string, unknown>;
type VisibleContent = AgentToolResult<Details>["content"];
const LIMIT = 50 * 1024;
const TRUNCATED = "\n[output truncated]";

function utf8Prefix(text: string, bytes: number): string {
	if (bytes <= 0) return "";
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return text;
	let end = bytes;
	while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}
function safeJson(value: unknown): string {
	try { return JSON.stringify(value, null, 2); }
	catch { return "[unserializable content]"; }
}
function alias(server: string, tool: string): string {
	return `${server}_${tool}`;
}

function visibleResourceReference(value: unknown): string | undefined {
	if (typeof value !== "string" || !value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
	try {
		const parsed = new URL(value);
		if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined;
		return value;
	} catch {
		return value.includes("?") || value.includes("#") || value.includes("@") ? undefined : value;
	}
}

function compactDetails(details: Details): Details {
	if (Buffer.byteLength(safeJson(details)) <= 12 * 1024) return details;
	const compact: Details = { detailsTruncated: true };
	for (const [key, value] of Object.entries(details)) {
		if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean" && value !== null) continue;
		compact[key] = typeof value === "string" ? utf8Prefix(value, 512) : value;
		if (Buffer.byteLength(safeJson(compact)) > 12 * 1024) {
			delete compact[key];
			break;
		}
	}
	return compact;
}

class OutputBudget {
	readonly content: VisibleContent = [];
	readonly details: Details;

	constructor(details: Details) {
		this.details = compactDetails(details);
	}

	private fits(content: VisibleContent, reserve = 0): boolean {
		return Buffer.byteLength(safeJson({ content, details: this.details })) + reserve <= LIMIT;
	}

	text(value: string, reserve = 256): void {
		const complete = [...this.content, { type: "text" as const, text: value }];
		if (this.fits(complete, reserve)) {
			this.content.push(complete.at(-1)!);
			return;
		}
		let low = 0;
		let high = Buffer.byteLength(value);
		let best = "";
		while (low <= high) {
			const middle = Math.floor((low + high) / 2);
			const prefix = utf8Prefix(value, middle);
			const candidateText = prefix ? `${prefix}${TRUNCATED}` : "";
			const candidate = candidateText ? [...this.content, { type: "text" as const, text: candidateText }] : this.content;
			if (this.fits(candidate, reserve)) {
				best = candidateText;
				low = middle + 1;
			} else {
				high = middle - 1;
			}
		}
		if (best) this.content.push({ type: "text", text: best });
	}

	image(data: string, mimeType: string): void {
		const candidate = [...this.content, { type: "image" as const, data, mimeType }];
		if (this.fits(candidate)) this.content.push(candidate.at(-1)!);
		else this.text("[image omitted: output budget exceeded]", 0);
	}

	result(): AgentToolResult<Details> {
		return { content: this.content, details: this.details };
	}
}

export interface McpRuntimeOptions {
	publisher?: AppPublisher;
	onUiStatus?: (status?: AppPublicationStatus) => void;
	publishApps?: boolean;
	tailscale?: TailscaleAdapter;
	gateway?: GatewayClient;
	context?: ExtensionContext;
}

export class McpRuntime {
	private readonly clientRequestAbort = new AbortController();
	readonly manager: McpServerManager;
	readonly config: McpConfig;
	readonly serverConfigs: ReturnType<typeof parseServerConfigs>["servers"];
	readonly disabledServers: ReturnType<typeof parseServerConfigs>["disabled"];
	readonly coordinator?: OAuthCoordinator;
	readonly gatewayConfigured: boolean;
	readonly apps: McpAppController;
	readonly publisher?: AppPublisher;
	readonly diagnostics;
	constructor(
		config: McpConfig,
		manager?: McpServerManager,
		coordinator?: OAuthCoordinator,
		apps?: McpAppController,
		options: McpRuntimeOptions = {},
	) {
		this.config = config;
		const parsed = parseServerConfigs(config);
		this.serverConfigs = parsed.servers;
		this.disabledServers = parsed.disabled;
		this.diagnostics = parsed.diagnostics;
		if (manager) {
			this.manager = manager;
			this.coordinator = coordinator;
			this.gatewayConfigured = !!coordinator;
			this.apps = apps ?? new McpAppController(manager);
			this.publisher = options.publisher;
			return;
		}
		const store = new OAuthStore();
		const context = options.context;
		const autoApprove = config.settings.samplingAutoApprove === true;
		const samplingEnabled = config.settings.sampling !== false && !!context && (context.hasUI || autoApprove);
		const elicitationEnabled = config.settings.elicitation !== false && !!context?.hasUI;
		let activeRequests = 0;
		const requestSignal = (signal?: AbortSignal): AbortSignal => AbortSignal.any([
			this.clientRequestAbort.signal,
			...(context?.signal ? [context.signal] : []),
			...(signal ? [signal] : []),
		]);
		const guarded = <T>(operation: () => Promise<T>): Promise<T> => {
			if (this.clientRequestAbort.signal.aborted) return Promise.reject(new Error("MCP client request is unavailable"));
			if (activeRequests >= 2) return Promise.reject(new Error("MCP client request capacity exceeded"));
			activeRequests++; return operation().finally(() => { activeRequests--; });
		};
		this.manager = new McpServerManager(parsed.servers.values(), async (name) => {
			const server = parsed.servers.get(name);
			return server && server.transport !== "stdio" ? StoredOAuthProvider.passive(server.url.href, store) : undefined;
		}, {
			sampling: samplingEnabled ? (server, params, signal) => guarded(() => sample(server, params, context!, autoApprove, requestSignal(signal))) : undefined,
			elicitation: elicitationEnabled ? (server, params, signal) => guarded(() => elicitForm(server, params, context!.ui, requestSignal(signal))) : undefined,
		});
		const baseSettings = { ...DEFAULT_UI_SETTINGS, ...config.settings.ui };
		const tailscale = options.tailscale ?? new TailscaleAdapter();
		const publication = config.settings.gateway;
		this.gatewayConfigured = publication !== undefined;
		let activePublisher: AppPublisher | undefined;
		this.apps = apps ?? new McpAppController(this.manager, {
			onChange: (current) => { void activePublisher?.reconcile(current); },
		});
		if (!publication) {
			this.coordinator = undefined;
			this.publisher = options.publisher;
			activePublisher = this.publisher;
			return;
		}
		const settings = publication.mode === "tailscale"
			? { ...baseSettings, requireTailscaleIdentity: true }
			: { ...baseSettings, basePath: new URL(publication.externalUrl).pathname || "/", requireTailscaleIdentity: false };
		const gateway = options.gateway ?? (publication.mode === "tailscale"
			? new GatewayClient({ settings, hostnameResolver: async () => {
				if (settings.hostname !== "auto") return settings.hostname;
				const hostname = await tailscale.hostname(); if (!hostname) throw new Error("Tailscale hostname unavailable"); return hostname;
			} })
			: new GatewayClient({ settings, externalUrlResolver: async () => publication.externalUrl, listenAddress: publication.listenAddress }));
		const exposure: GatewayExposure = publication.mode === "tailscale"
			? new TailscaleGatewayExposure(settings, tailscale, gateway)
			: new CustomGatewayExposure(gateway);
		this.coordinator = new OAuthCoordinator(this.manager, parsed.servers, settings, gateway, exposure, store);
		this.publisher = options.publishApps === false
			? undefined
			: options.publisher ?? new AppPublisher({
				settings,
				gateway,
				exposure,
				backend: () => this.apps.backend(),
				onStatus: options.onUiStatus,
			});
		activePublisher = this.publisher;
	}

	async execute(input: Input, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		if (input.action) {
			if (input.search !== undefined || input.connect !== undefined || input.tool !== undefined) throw new Error("MCP actions cannot be combined with another MCP operation");
			if (input.action === "diagnostics") {
				if (input.args !== undefined) throw new Error("diagnostics does not accept args");
				if (input.server && !this.serverConfigs.has(input.server)) throw new Error("Unknown MCP server");
				const servers = this.manager.diagnosticStatus(input.server);
				const configDiagnostics = [
					...this.config.diagnostics.map(({ code, path }) => ({ code, path: utf8Prefix(path, 512) })),
					...this.diagnostics.filter((item) => !input.server || item.server === input.server).map(({ server, code }) => ({ code, path: `mcpServers.${utf8Prefix(server, 64)}` })),
				].slice(0, 200);
				return this.text(safeJson({ servers, configDiagnostics }), { action: "diagnostics", serverCount: servers.length, diagnosticCount: configDiagnostics.length });
			}
			if (!input.server) throw new Error("MCP actions require server");
			if (input.action === "resources-list") {
				if (input.args !== undefined) throw new Error("resources-list does not accept args");
				const listed = await this.manager.listResources(input.server, signal);
				const lines = [
					...listed.resources.slice(0, 200).map((item) => {
						const reference = visibleResourceReference(item.uri);
						return `resource: ${utf8Prefix(item.name, 256)}${reference ? ` — ${utf8Prefix(reference, 4_096)}` : " [URI hidden]"}${item.mimeType ? ` (${utf8Prefix(item.mimeType, 128)})` : ""}`;
					}),
					...listed.resourceTemplates.slice(0, 200).map((item) => {
						const reference = visibleResourceReference(item.uriTemplate);
						return `template: ${utf8Prefix(item.name, 256)}${reference ? ` — ${utf8Prefix(reference, 4_096)}` : " [URI template hidden]"}`;
					}),
				];
				return this.text(lines.join("\n") || "No MCP resources.", { server: input.server, action: input.action, resourceCount: listed.resources.length, templateCount: listed.resourceTemplates.length });
			}
			if (input.action === "resources-read") {
				if (!input.args || Object.keys(input.args).length !== 1 || typeof input.args.uri !== "string" || !input.args.uri || input.args.uri.length > 4096) throw new Error("resources-read requires only bounded args.uri");
				const result = await this.manager.readResource(input.server, input.args.uri, signal);
				return this.renderBlocks(result.contents, { server: input.server, action: input.action }, "MCP resource returned no content.");
			}
			if (input.action === "prompts-list") {
				if (input.args !== undefined) throw new Error("prompts-list does not accept args");
				const prompts = await this.manager.listPrompts(input.server, signal);
				return this.text(prompts.slice(0, 200).map((item) => `${utf8Prefix(item.name, 256)}${item.description ? ` — ${utf8Prefix(item.description, 500)}` : ""}`).join("\n") || "No MCP prompts.", { server: input.server, action: input.action, count: prompts.length });
			}
			if (input.action === "prompts-get") {
				if (!input.args || typeof input.args.name !== "string" || !input.args.name || input.args.name.length > 500) throw new Error("prompts-get requires bounded args.name");
				const keys = Object.keys(input.args); if (keys.some((key) => key !== "name" && key !== "arguments")) throw new Error("prompts-get accepts only args.name and args.arguments");
				const values = input.args.arguments ?? {}; if (typeof values !== "object" || values === null || Array.isArray(values) || Object.keys(values).length > 50 || Object.entries(values).some(([key, value]) => key.length > 256 || typeof value !== "string" || value.length > 4096)) throw new Error("prompts-get arguments must be a bounded string object");
				const result = await this.manager.getPrompt(input.server, input.args.name, values as Record<string, string>, signal);
				return this.renderBlocks(result.messages.map((message) => message.content), { server: input.server, action: input.action, prompt: utf8Prefix(input.args.name, 500) }, "MCP prompt returned no messages.");
			}
			if (!this.coordinator) throw new Error(this.gatewayConfigured ? "MCP OAuth is unavailable" : "MCP gateway is not configured");
			if (input.action === "auth-start") {
				if (input.args !== undefined) throw new Error("auth-start does not accept args");
				const result = await this.coordinator.begin(input.server);
				return this.text(`Open this authorization URL (it is not opened automatically):\n${result.authorizationUrl}`, { state: "authorization-required", server: input.server, authorizationUrl: result.authorizationUrl });
			}
			if (!input.args || Object.keys(input.args).length !== 1 || typeof input.args.redirectUrl !== "string") throw new Error("auth-complete requires only args.redirectUrl");
			await this.coordinator.complete(input.server, input.args.redirectUrl);
			return this.text(`Authentication complete for ${input.server}.`, { state: "connected", server: input.server });
		}
		const operations = [input.server, input.search, input.connect, input.tool]
			.filter((value) => value !== undefined).length;
		if (operations > 1 && !(input.tool && input.server && operations === 2)) {
			throw new Error("Specify exactly one MCP operation (server may qualify tool)");
		}
		if (input.args && !input.tool) throw new Error("args requires tool");
		if (!operations) {
			const servers = this.manager.status().map(({ name, state }) => ({ name, state }));
			return this.text(servers.map((server) => `${server.name}: ${server.state}`).join("\n") ||
				"No valid MCP servers configured.", { servers, invalidServerCount: this.diagnostics.length });
		}
		if (input.connect) {
			await this.manager.connect(input.connect, true, signal);
			return this.list(input.connect);
		}
		if (input.server && !input.tool) {
			await this.manager.connect(input.server, false, signal);
			return this.list(input.server);
		}
		if (input.search !== undefined) return this.search(input.search, signal);
		return this.invoke(input.tool!, input.args ?? {}, input.server, signal);
	}

	private async search(query: string, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		await Promise.allSettled(this.manager.status().map((server) => this.manager.connect(server.name, false, signal)));
		const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
		const hits = this.manager.status().flatMap((server) => this.manager.modelTools(server.name).map((tool) => ({
			server: server.name,
			tool,
			score: terms.reduce((score, term) => score +
				(tool.name.toLowerCase().includes(term) ? 4 : 0) +
				((tool.description ?? "").toLowerCase().includes(term) ? 1 : 0), 0),
		}))).filter((hit) => !terms.length || hit.score > 0)
			.sort((a, b) => b.score - a.score || alias(a.server, a.tool.name).localeCompare(alias(b.server, b.tool.name)))
			.slice(0, 100);
		return this.text(hits.map((hit) => `${alias(hit.server, hit.tool.name)} — ${(hit.tool.description ?? "").slice(0, 500)}`)
			.join("\n") || "No matching MCP tools.", { count: hits.length });
	}

	async executeDirect(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		return this.invoke(tool, args, server, signal);
	}

	private async invoke(tool: string, args: Record<string, unknown>, server: string | undefined, signal?: AbortSignal) {
		let targetServer = server;
		let targetTool = tool;
		if (!targetServer) {
			const aliases = this.manager.status()
				.filter((candidate) => tool.startsWith(`${candidate.name}_`))
				.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
			if (aliases.length) {
				targetServer = aliases[0]!.name;
				targetTool = tool.slice(targetServer.length + 1);
			}
		}
		if (targetServer) {
			await this.manager.connect(targetServer, false, signal);
			if (!this.manager.modelTool(targetServer, targetTool)) throw new Error("Unknown MCP tool");
		} else {
			await Promise.allSettled(this.manager.status().map((candidate) => this.manager.connect(candidate.name, false, signal)));
			const matches = this.manager.status().flatMap((candidate) =>
				this.manager.modelTools(candidate.name).filter((item) => item.name === targetTool).map(() => candidate.name));
			if (matches.length > 1) throw new Error("Ambiguous MCP tool name; specify server or stable alias");
			if (!matches.length) throw new Error("Unknown MCP tool");
			targetServer = matches[0]!;
		}
		const metadata = this.manager.modelTool(targetServer, targetTool)!;
		const result = await this.manager.callFromModel(targetServer, targetTool, args, signal);
		let ui: { state: "available" | "unavailable" } | undefined;
		try {
			const opened = await this.apps.open(targetServer, metadata, args, result, signal);
			if (opened) ui = { state: this.publisher ? (await this.publisher.reconcile(this.apps.list())).state : "available" };
		} catch {
			ui = { state: "unavailable" };
		}
		const details = { server: targetServer, tool: targetTool, isError: result.isError === true, ...(ui ? { ui } : {}) };
		const budget = new OutputBudget(details);
		if (result.isError) budget.text("MCP tool reported an error.\n");
		for (const item of result.content ?? []) {
			if (item.type === "text") budget.text(item.text);
			else if (item.type === "image") budget.image(item.data, item.mimeType);
			else budget.text(`[${item.type}] ${safeJson(item)}`);
		}
		if (result.structuredContent !== undefined) {
			budget.text(`[structured content]\n${safeJson(result.structuredContent)}`);
		}
		if (!budget.content.length) budget.text(result.isError ? "MCP tool reported an error." : "MCP tool returned no content.");
		return budget.result();
	}

	async close(): Promise<void> {
		this.clientRequestAbort.abort();
		const cleanup = await Promise.allSettled([
			this.apps.close(),
			this.publisher?.close(),
			this.coordinator?.close(),
		]);
		const manager = await Promise.allSettled([this.manager.close()]);
		const failures = [...cleanup, ...manager].filter((result) => result.status === "rejected");
		if (failures.length) throw new AggregateError(failures.map((result) => (result as PromiseRejectedResult).reason), "MCP runtime cleanup failed");
	}

	private list(name: string): AgentToolResult<Details> {
		const server = this.manager.get(name)!;
		const modelTools = this.manager.modelTools(name);
		const tools = modelTools.slice(0, 25).map((tool) => ({
			name: utf8Prefix(tool.name, 256),
			alias: utf8Prefix(alias(name, tool.name), 320),
		}));
		const body = `Server ${name}: ${server.state}\n` +
			(server.instructions ? `Instructions: ${server.instructions.slice(0, 2000)}\n` : "") +
			modelTools.map((tool) => `${alias(name, tool.name)} — ${(tool.description ?? "").slice(0, 500)}`).join("\n");
		return this.text(body, { server: name, state: server.state, count: modelTools.length, tools });
	}

	private renderBlocks(blocks: Array<Record<string, unknown>>, details: Details, empty: string): AgentToolResult<Details> {
		const budget = new OutputBudget(details);
		for (const block of blocks) {
			if ((block.type === "text" || block.type === undefined) && typeof block.text === "string") budget.text(block.text);
			else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") budget.image(block.data, block.mimeType);
			else if ((block.type === "blob" || block.type === undefined) && typeof block.blob === "string") budget.text(`[binary resource omitted${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""}]`);
			else if (block.type === "resource" || block.type === "resource_link") budget.text(`[embedded resource omitted]`);
			else if (block.type === "audio") budget.text(`[audio omitted${typeof block.mimeType === "string" ? `: ${block.mimeType}` : ""}]`);
			else budget.text(`[unsupported MCP content: ${typeof block.type === "string" ? block.type : "unknown"}]`);
		}
		if (!budget.content.length) budget.text(empty);
		return budget.result();
	}

	private text(text: string, details: Details): AgentToolResult<Details> {
		const budget = new OutputBudget(details);
		budget.text(text);
		return budget.result();
	}
}

export function registerMcpTool(pi: ExtensionAPI, getRuntime: () => McpRuntime | undefined): void {
	pi.registerTool({
		name: "mcp",
		label: "MCP",
		description: "Inspect, search, connect to, and call configured remote MCP servers",
		parameters: Params,
		async execute(_id, input, signal) {
			const runtime = getRuntime();
			if (!runtime) return {
				content: [{ type: "text", text: "MCP is unavailable before session start." }],
				details: { state: "unavailable" },
			};
			return runtime.execute(input, signal);
		},
	});
}
