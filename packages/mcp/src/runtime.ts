import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { DEFAULT_UI_SETTINGS, type McpConfig } from "./config.js";
import { parseHttpServerConfigs } from "./mcp/config.js";
import { McpServerManager } from "./mcp/manager.js";
import { OAuthCoordinator } from "./auth/coordinator.js";
import { OAuthStore } from "./auth/store.js";
import { StoredOAuthProvider } from "./auth/provider.js";
import { GatewayClient } from "./gateway/client.js";
import { TailscaleAdapter } from "./tailscale.js";

const Params = Type.Object({
	server: Type.Optional(Type.String({ maxLength: 64 })),
	search: Type.Optional(Type.String({ maxLength: 500 })),
	connect: Type.Optional(Type.String({ maxLength: 64 })),
	tool: Type.Optional(Type.String({ maxLength: 500 })),
	args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	action: Type.Optional(Type.Union([Type.Literal("auth-start"), Type.Literal("auth-complete")])),
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

export class McpRuntime {
	readonly manager: McpServerManager;
	readonly coordinator?: OAuthCoordinator;
	readonly diagnostics;
	constructor(config: McpConfig, manager?: McpServerManager, coordinator?: OAuthCoordinator) {
		const parsed = parseHttpServerConfigs(config);
		this.diagnostics = parsed.diagnostics;
		if (manager) { this.manager = manager; this.coordinator = coordinator; return; }
		const store = new OAuthStore();
		this.manager = new McpServerManager(parsed.servers.values(), async (name) => {
			const server = parsed.servers.get(name);
			return server ? StoredOAuthProvider.passive(server.url.href, store) : undefined;
		});
		const settings = { ...DEFAULT_UI_SETTINGS, ...config.settings.ui };
		const tailscale = new TailscaleAdapter();
		const gateway = new GatewayClient({ settings, hostnameResolver: async () => {
			if (settings.hostname !== "auto") return settings.hostname;
			const hostname = await tailscale.hostname(); if (!hostname) throw new Error("Tailscale hostname unavailable"); return hostname;
		} });
		this.coordinator = new OAuthCoordinator(this.manager, parsed.servers, settings, gateway, tailscale, store);
	}

	async execute(input: Input, signal?: AbortSignal): Promise<AgentToolResult<Details>> {
		if (input.action) {
			if (!input.server) throw new Error("OAuth actions require server");
			if (input.search !== undefined || input.connect !== undefined || input.tool !== undefined) throw new Error("OAuth actions cannot be combined with another MCP operation");
			if (!this.coordinator) throw new Error("MCP OAuth is unavailable");
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
			await this.manager.connect(input.connect, true);
			return this.list(input.connect);
		}
		if (input.server && !input.tool) {
			await this.manager.connect(input.server);
			return this.list(input.server);
		}
		if (input.search !== undefined) return this.search(input.search);
		return this.invoke(input.tool!, input.args ?? {}, input.server, signal);
	}

	private async search(query: string): Promise<AgentToolResult<Details>> {
		await Promise.allSettled(this.manager.status().map((server) => this.manager.connect(server.name)));
		const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
		const hits = this.manager.status().flatMap((server) => server.tools.map((tool) => ({
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
			await this.manager.connect(targetServer);
			const match = this.manager.get(targetServer)?.tools.find((candidate) => candidate.name === targetTool);
			if (!match) throw new Error("Unknown MCP tool");
		} else {
			await Promise.allSettled(this.manager.status().map((candidate) => this.manager.connect(candidate.name)));
			const matches = this.manager.status().flatMap((candidate) =>
				candidate.tools.filter((item) => item.name === targetTool).map(() => candidate.name));
			if (matches.length > 1) throw new Error("Ambiguous MCP tool name; specify server or stable alias");
			if (!matches.length) throw new Error("Unknown MCP tool");
			targetServer = matches[0]!;
		}
		const result = await this.manager.call(targetServer, targetTool, args, signal);
		const details = { server: targetServer, tool: targetTool, isError: result.isError === true };
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

	private list(name: string): AgentToolResult<Details> {
		const server = this.manager.get(name)!;
		const tools = server.tools.slice(0, 25).map((tool) => ({
			name: utf8Prefix(tool.name, 256),
			alias: utf8Prefix(alias(name, tool.name), 320),
		}));
		const body = `Server ${name}: ${server.state}\n` +
			(server.instructions ? `Instructions: ${server.instructions.slice(0, 2000)}\n` : "") +
			server.tools.map((tool) => `${alias(name, tool.name)} — ${(tool.description ?? "").slice(0, 500)}`).join("\n");
		return this.text(body, { server: name, state: server.state, count: server.tools.length, tools });
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
