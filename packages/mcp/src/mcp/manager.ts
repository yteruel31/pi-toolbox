import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HttpServerConfig } from "./config.js";

export type ServerState = "disconnected" | "connecting" | "connected" | "auth-required" | "error";
export interface ConnectedServer {
	name: string;
	state: ServerState;
	instructions?: string;
	/** Raw SDK metadata is retained internally for the later Apps layer. */
	tools: Tool[];
}
interface Entry extends ConnectedServer {
	config: HttpServerConfig;
	client?: Client;
	transport?: StreamableHTTPClientTransport;
	pending?: Promise<ConnectedServer>;
	epoch: number;
}
export type AuthProviderFactory = (server: string) => OAuthClientProvider | undefined;

function isAuthFailure(error: unknown): boolean {
	return error instanceof UnauthorizedError ||
		(error instanceof StreamableHTTPError && error.code === 401) ||
		(typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 401);
}

export class McpServerManager {
	private readonly entries = new Map<string, Entry>();
	private closing?: Promise<void>;
	private closed = false;

	constructor(configs: Iterable<HttpServerConfig>, private readonly authProviderFactory?: AuthProviderFactory) {
		for (const config of configs) {
			this.entries.set(config.name, { name: config.name, config, state: "disconnected", tools: [], epoch: 0 });
		}
	}

	status(): ConnectedServer[] {
		return [...this.entries.values()]
			.map(({ name, state, instructions, tools }) => ({ name, state, instructions, tools }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): ConnectedServer | undefined {
		return this.status().find((server) => server.name === name);
	}

	async connect(name: string, refresh = false): Promise<ConnectedServer> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		if (this.closed) throw new Error("MCP manager is closed");
		if (entry.pending) return entry.pending;
		if (entry.state === "connected" && !refresh) return entry;
		const epoch = entry.epoch;
		const pending = this.open(entry, refresh, epoch);
		entry.pending = pending;
		void pending.finally(() => {
			if (entry.pending === pending) entry.pending = undefined;
		}).catch(() => undefined);
		return pending;
	}

	private async open(entry: Entry, refresh: boolean, epoch: number): Promise<ConnectedServer> {
		if (refresh) await this.closeResources(entry);
		entry.state = "connecting";
		const client = new Client({ name: "pi-mcp", version: "0.1.0" });
		const transport = new StreamableHTTPClientTransport(entry.config.url, {
			requestInit: { headers: entry.config.headers },
			authProvider: this.authProviderFactory?.(entry.name),
		});
		entry.client = client;
		entry.transport = transport;
		try {
			await client.connect(transport);
			const listed = await client.listTools();
			if (entry.epoch !== epoch) {
				await transport.close().catch(() => undefined);
				throw new Error("MCP connection was closed during startup");
			}
			entry.tools = [...listed.tools].sort((a, b) => a.name.localeCompare(b.name));
			entry.instructions = client.getInstructions();
			entry.state = "connected";
			return entry;
		} catch (error) {
			const interrupted = entry.epoch !== epoch;
			if (!interrupted) entry.state = isAuthFailure(error) ? "auth-required" : "error";
			await this.closeResources(entry);
			if (interrupted) throw new Error("MCP connection was closed during startup");
			throw new Error(isAuthFailure(error)
				? `Authentication required for MCP server ${entry.name}`
				: `MCP server ${entry.name} could not connect`);
		}
	}

	async call(
		name: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<CallToolResult> {
		const entry = this.entries.get(name);
		if (!entry) throw new Error(`Unknown MCP server: ${name}`);
		await this.connect(name);
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
		try { await transport?.close(); } catch { /* close is best effort */ }
	}

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.closing = (async () => {
			for (const entry of this.entries.values()) entry.epoch++;
			await Promise.all([...this.entries.values()].map(async (entry) => {
				await this.closeResources(entry);
				try { await entry.pending; } catch { /* expected for interrupted opens */ }
				await this.closeResources(entry);
				entry.state = "disconnected";
				entry.tools = [];
				entry.instructions = undefined;
			}));
		})();
		return this.closing;
	}
}
