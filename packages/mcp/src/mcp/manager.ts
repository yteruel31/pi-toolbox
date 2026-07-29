import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport, SseError } from "@modelcontextprotocol/sdk/client/sse.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isToolVisibilityAppOnly, isToolVisibilityModelOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult, GetPromptResult, Prompt, ReadResourceResult, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";

export type ServerState = "disconnected" | "connecting" | "connected" | "auth-required" | "error";
export interface ConnectedServer {
	name: string;
	state: ServerState;
	instructions?: string;
	/** Raw SDK metadata is retained internally; model-visible callers must project safe fields. */
	tools: Tool[];
	resources: Resource[];
	resourceTemplates: ResourceTemplate[];
	prompts: Prompt[];
}
interface Entry extends ConnectedServer {
	config: ServerConfig;
	client?: Client;
	transport?: Transport;
	authTransport?: StreamableHTTPClientTransport | SSEClientTransport;
	pending?: Promise<ConnectedServer>;
	epoch: number;
	authActive?: boolean;
	authPending?: Promise<void>;
}
export type AuthProviderFactory = (server: string) => OAuthClientProvider | undefined | Promise<OAuthClientProvider | undefined>;

function isAuthFailure(error: unknown): boolean {
	return error instanceof UnauthorizedError ||
		(error instanceof StreamableHTTPError && error.code === 401) ||
		(error instanceof SseError && error.code === 401) ||
		(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 401);
}

export class McpServerManager {
	private readonly entries = new Map<string, Entry>();
	private closing?: Promise<void>;
	private closed = false;

	private metadataListener?: () => void;

	constructor(configs: Iterable<ServerConfig>, private readonly authProviderFactory?: AuthProviderFactory) {
		for (const config of configs) {
			this.entries.set(config.name, { name: config.name, config, state: "disconnected", tools: [], resources: [], resourceTemplates: [], prompts: [], epoch: 0 });
		}
	}

	onMetadataChange(listener: () => void): void { this.metadataListener = listener; }

	status(): ConnectedServer[] {
		return [...this.entries.values()]
			.map(({ name, state, instructions, tools, resources, resourceTemplates, prompts }) => ({ name, state, instructions, tools, resources, resourceTemplates, prompts }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): ConnectedServer | undefined {
		return this.status().find((server) => server.name === name);
	}

	async connect(name: string, refresh = false, signal?: AbortSignal): Promise<ConnectedServer> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		if (this.closed) throw new Error("MCP manager is closed");
		if (entry.authActive) throw new Error(`OAuth is active for MCP server ${name}`);
		if (entry.pending) return entry.pending;
		if (entry.state === "connected" && !refresh) return entry;
		const epoch = entry.epoch;
		const pending = this.open(entry, refresh, epoch, undefined, false, signal);
		entry.pending = pending;
		void pending.finally(() => {
			if (entry.pending === pending) entry.pending = undefined;
		}).catch(() => undefined);
		return pending;
	}

	private createTransport(config: ServerConfig, provider?: OAuthClientProvider, legacy = false): Transport {
		if (config.transport === "stdio") return new StdioClientTransport({
			command: config.command, args: config.args ? [...config.args] : undefined,
			env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
			cwd: config.cwd,
			stderr: "ignore",
		});
		if (legacy || config.transport === "sse") {
			const fetchWithHeaders: typeof fetch = (input, init) => fetch(input, { ...init, headers: { ...config.headers, ...Object.fromEntries(new Headers(init?.headers).entries()) } });
			return new SSEClientTransport(config.url, { authProvider: provider, fetch: fetchWithHeaders });
		}
		return new StreamableHTTPClientTransport(config.url, { requestInit: { headers: config.headers }, authProvider: provider });
	}

	private async open(entry: Entry, refresh: boolean, epoch: number, provider?: OAuthClientProvider, retainAuth = false, signal?: AbortSignal): Promise<ConnectedServer> {
		if (refresh) await this.closeResources(entry);
		entry.state = "connecting";
		if (provider && entry.config.transport === "stdio") throw new Error(`OAuth is unavailable for MCP server ${entry.name}`);
		const authProvider = entry.config.transport === "stdio" ? undefined : provider ?? await this.authProviderFactory?.(entry.name);
		const client = new Client({ name: "pi-mcp", version: "0.1.0" });
		let transport = this.createTransport(entry.config, authProvider);
		entry.client = client; entry.transport = transport;
		if (transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport) entry.authTransport = transport;
		try {
			if (signal?.aborted) throw new Error("MCP connection cancelled");
			try { await client.connect(transport); }
			catch (error) {
				const auto = entry.config.transport === "auto";
				const unsupported = error instanceof StreamableHTTPError && (error.code === 404 || error.code === 405);
				if (!auto || !unsupported || entry.epoch !== epoch || signal?.aborted) throw error;
				await transport.close().catch(() => undefined);
				transport = this.createTransport(entry.config, authProvider, true);
				entry.transport = transport; entry.authTransport = transport as SSEClientTransport;
				await client.connect(transport);
			}
			if (signal?.aborted) throw new Error("MCP connection cancelled");
			const capabilities = client.getServerCapabilities();
			entry.tools = capabilities?.tools ? await this.paginate<Tool>((cursor) => client.listTools(cursor ? { cursor } : undefined, { signal }), "tools", signal) : [];
			entry.resources = capabilities?.resources ? await this.paginate<Resource>((cursor) => client.listResources(cursor ? { cursor } : undefined, { signal }), "resources", signal) : [];
			entry.resourceTemplates = capabilities?.resources ? await this.paginate<ResourceTemplate>((cursor) => client.listResourceTemplates(cursor ? { cursor } : undefined, { signal }), "resourceTemplates", signal) : [];
			entry.prompts = capabilities?.prompts ? await this.paginate<Prompt>((cursor) => client.listPrompts(cursor ? { cursor } : undefined, { signal }), "prompts", signal) : [];
			if (entry.epoch !== epoch) {
				await transport.close().catch(() => undefined);
				throw new Error("MCP connection was closed during startup");
			}
			entry.tools.sort((a, b) => a.name.localeCompare(b.name));
			entry.resources.sort((a, b) => a.name.localeCompare(b.name));
			entry.resourceTemplates.sort((a, b) => a.name.localeCompare(b.name));
			entry.prompts.sort((a, b) => a.name.localeCompare(b.name));
			entry.instructions = client.getInstructions();
			entry.state = "connected";
			this.metadataListener?.();
			return entry;
		} catch (error) {
			const interrupted = entry.epoch !== epoch;
			const cancelled = signal?.aborted === true;
			const authFailure = isAuthFailure(error);
			if (!interrupted) entry.state = cancelled ? "disconnected" : authFailure ? "auth-required" : "error";
			if (!(retainAuth && authFailure && !interrupted)) await this.closeResources(entry);
			if (interrupted) throw new Error("MCP connection was closed during startup");
			if (cancelled) throw new Error(`MCP connection cancelled on ${entry.name}`);
			throw new Error(isAuthFailure(error)
				? `Authentication required for MCP server ${entry.name}`
				: `MCP server ${entry.name} could not connect`);
		}
	}

	async beginAuth(name: string, provider: OAuthClientProvider): Promise<void> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		if (this.closed) throw new Error("MCP manager is closed");
		if (entry.config.transport === "stdio") throw new Error(`OAuth is unavailable for MCP server ${name}`);
		if (entry.authActive) throw new Error("OAuth attempt already active");
		if (entry.pending) {
			try { await entry.pending; } catch { /* the auth open supersedes it */ }
		}
		if (this.closed) throw new Error("MCP manager is closed");
		entry.authActive = true;
		const authPending = (async () => {
			try {
				await this.open(entry, true, entry.epoch, provider, true);
			} catch {
				if (entry.state !== "auth-required") {
					entry.authActive = false;
					throw new Error(`OAuth could not start for MCP server ${name}`);
				}
			}
		})();
		entry.authPending = authPending;
		try {
			await authPending;
		} finally {
			if (entry.authPending === authPending) entry.authPending = undefined;
		}
	}

	async finishAuth(name: string, code: string): Promise<ConnectedServer> {
		if (this.closed) throw new Error("MCP manager is closed");
		const entry = this.entries.get(name); if (!entry?.authActive || !entry.authTransport || entry.state !== "auth-required") throw new Error("No active OAuth attempt");
		try { await entry.authTransport.finishAuth(code); }
		catch { entry.authActive = false; await this.closeResources(entry); entry.state = "error"; throw new Error(`OAuth could not complete for MCP server ${name}`); }
		entry.authActive = false;
		await this.closeResources(entry);
		return this.connect(name, true);
	}

	async cancelAuth(name: string): Promise<void> {
		const entry = this.entries.get(name);
		if (!entry?.authActive) return;
		entry.authActive = false;
		entry.epoch++;
		await this.closeResources(entry);
		try { await entry.authPending; } catch { /* cancellation interrupts startup */ }
		await this.closeResources(entry);
		entry.state = "disconnected";
	}

	tool(name: string, tool: string): Tool | undefined {
		return this.entries.get(name)?.tools.find(candidate => candidate.name === tool);
	}

	modelTools(name: string): Tool[] {
		return this.entries.get(name)?.tools.filter((tool) => !isToolVisibilityAppOnly(tool)) ?? [];
	}

	modelTool(name: string, tool: string): Tool | undefined {
		return this.modelTools(name).find((candidate) => candidate.name === tool);
	}

	private async paginate<T>(request: (cursor?: string) => Promise<Record<string, unknown>>, key: string, signal?: AbortSignal): Promise<T[]> {
		const items: T[] = []; const cursors = new Set<string>(); let cursor: string | undefined; let metadataBytes = 0;
		for (let page = 0; page < 20 && items.length < 500; page++) {
			if (signal?.aborted) throw new Error("MCP discovery cancelled");
			const result = await request(cursor); const batch = Array.isArray(result[key]) ? result[key] as T[] : [];
			for (const item of batch) {
				if (items.length >= 500) break;
				let bytes: number; try { bytes = Buffer.byteLength(JSON.stringify(item)); } catch { continue; }
				if (bytes > 512 * 1024 - metadataBytes) break;
				metadataBytes += bytes; items.push(item);
			}
			const next = typeof result.nextCursor === "string" && result.nextCursor.length <= 1024 ? result.nextCursor : undefined;
			if (!next || cursors.has(next)) break; cursors.add(next); cursor = next;
		}
		return items;
	}

	async listResources(name: string, signal?: AbortSignal): Promise<{ resources: Resource[]; resourceTemplates: ResourceTemplate[] }> {
		if (signal?.aborted) throw new Error(`MCP resource listing cancelled on ${name}`);
		const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		await this.connect(name, false, signal); if (signal?.aborted) throw new Error(`MCP resource listing cancelled on ${name}`);
		return { resources: [...entry.resources], resourceTemplates: [...entry.resourceTemplates] };
	}

	async listPrompts(name: string, signal?: AbortSignal): Promise<Prompt[]> {
		if (signal?.aborted) throw new Error(`MCP prompt listing cancelled on ${name}`);
		const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		await this.connect(name, false, signal); if (signal?.aborted) throw new Error(`MCP prompt listing cancelled on ${name}`);
		return [...entry.prompts];
	}

	async getPrompt(name: string, prompt: string, args: Record<string, string> = {}, signal?: AbortSignal): Promise<GetPromptResult> {
		const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		await this.connect(name, false, signal);
		if (!entry.prompts.some((candidate) => candidate.name === prompt)) throw new Error("Unknown MCP prompt");
		try { return await entry.client!.getPrompt({ name: prompt, arguments: args }, { signal }); }
		catch (error) { if (isAuthFailure(error)) entry.state = "auth-required"; throw new Error(signal?.aborted ? `MCP prompt request cancelled on ${name}` : isAuthFailure(error) ? `Authentication required for MCP server ${name}` : `MCP prompt request failed on ${name}`); }
	}

	async readResource(name: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		const entry = this.entries.get(name); if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		await this.connect(name, false, signal);
		try { return await entry.client!.readResource({ uri }, { signal }); }
		catch (error) { if (isAuthFailure(error)) entry.state = "auth-required"; throw new Error(signal?.aborted ? `MCP resource read cancelled on ${name}` : isAuthFailure(error) ? `Authentication required for MCP server ${name}` : `MCP resource read failed on ${name}`); }
	}

	/** App calls are deliberately scoped by the owning session's server name. */
	async callFromApp(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		const metadata = this.tool(name, tool);
		if (!metadata || isToolVisibilityModelOnly(metadata)) throw new Error("Unknown same-server MCP tool");
		return this.call(name, tool, args, signal);
	}

	async callFromModel(name: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		if (!this.modelTool(name, tool)) throw new Error("Unknown MCP tool");
		return this.call(name, tool, args, signal);
	}

	private async call(
		name: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		await this.connect(name, false, signal);
		try {
			return await entry.client!.callTool(
				{ name: tool, arguments: args }, undefined, { signal },
			) as CallToolResult;
		} catch (error) {
			if (isAuthFailure(error)) entry.state = "auth-required";
			if (signal?.aborted) throw new Error(`MCP tool call cancelled on ${name}`);
			throw new Error(isAuthFailure(error)
				? `Authentication required for MCP server ${name}`
				: `MCP tool call failed on ${name}`);
		}
	}

	private async closeResources(entry: Entry): Promise<void> {
		const transport = entry.transport;
		entry.client = undefined;
		entry.transport = undefined;
		entry.authTransport = undefined;
		entry.tools = []; entry.resources = []; entry.resourceTemplates = []; entry.prompts = []; entry.instructions = undefined;
		try { await transport?.close(); } catch { /* close is best effort */ }
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			for (const entry of this.entries.values()) entry.epoch++;
			await Promise.all([...this.entries.values()].map(async (entry) => {
				entry.authActive = false;
				await this.closeResources(entry);
				try { await entry.pending; } catch { /* expected for interrupted opens */ }
				try { await entry.authPending; } catch { /* expected for interrupted auth */ }
				await this.closeResources(entry);
				entry.state = "disconnected";
				entry.tools = [];
				entry.instructions = undefined;
			}));
			this.metadataListener?.();
		})();
		return this.closing;
	}
}
