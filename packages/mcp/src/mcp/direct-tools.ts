import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import type { DirectToolsSetting } from "../config.js";
import type { McpRuntime } from "../runtime.js";

const SAFE_MCP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_DIRECT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SCHEMA_BYTES = 64 * 1024;

function selected(setting: DirectToolsSetting | undefined, global: boolean, name: string): boolean {
	const effective = setting ?? global;
	return effective === true || Array.isArray(effective) && effective.includes(name);
}

function safeSchema(value: unknown, depth = 0, budget = { nodes: 0 }): boolean {
	if (++budget.nodes > 5_000 || depth > 32) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return true;
	if (Array.isArray(value)) return value.every((item) => safeSchema(item, depth + 1, budget));
	if (typeof value !== "object") return false;
	return Object.entries(value as Record<string, unknown>).every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && safeSchema(item, depth + 1, budget));
}

function schemaFingerprint(tool: Tool): string | undefined {
	if (!SAFE_MCP_NAME.test(tool.name) || typeof tool.inputSchema !== "object" || tool.inputSchema === null || Array.isArray(tool.inputSchema) || !safeSchema(tool.inputSchema)) return undefined;
	try {
		const encoded = JSON.stringify(tool.inputSchema);
		if (!encoded || Buffer.byteLength(encoded) > MAX_SCHEMA_BYTES) return undefined;
		return encoded;
	} catch { return undefined; }
}

export class DirectToolRegistry {
	private runtime?: McpRuntime;
	private generation = 0;
	private readonly owned = new Set<string>();
	private readonly fingerprints = new Map<string, string>();

	constructor(private readonly pi: ExtensionAPI) {}

	attach(runtime: McpRuntime): void {
		this.runtime = runtime;
		this.generation++;
		runtime.manager.onMetadataChange(() => {
			if (this.runtime !== runtime) return;
			try { this.sync(); } catch { /* direct tool registration must not break MCP discovery */ }
		});
		try { this.sync(); } catch { /* keep the unified MCP tool available */ }
	}

	detach(runtime?: McpRuntime): void {
		if (runtime && this.runtime !== runtime) return;
		this.runtime = undefined;
		this.generation++;
		this.setActivation(new Set());
	}

	startDiscovery(runtime: McpRuntime): void {
		const jobs = [...runtime.serverConfigs.values()]
			.filter((server) => {
				const effective = server.directTools ?? runtime.config.settings.directTools ?? false;
				return effective === true || Array.isArray(effective) && effective.length > 0;
			})
			.map((server) => runtime.manager.connect(server.name, false).catch(() => undefined));
		void Promise.allSettled(jobs);
	}

	sync(): void {
		const runtime = this.runtime;
		if (!runtime) return;
		const desired = new Set<string>();
		const existing = new Set(this.pi.getAllTools().map((tool) => tool.name));
		for (const server of runtime.manager.status()) {
			const setting = runtime.serverConfigs.get(server.name)?.directTools;
			for (const tool of runtime.manager.modelTools(server.name)) {
				if (!selected(setting, runtime.config.settings.directTools ?? false, tool.name)) continue;
				const name = `${server.name}_${tool.name}`;
				const schema = schemaFingerprint(tool);
				if (!schema || !SAFE_DIRECT_NAME.test(name) || name === "mcp") continue;
				if (existing.has(name) && !this.owned.has(name)) continue;
				desired.add(name);
				const fingerprint = `${this.generation}\0${server.name}\0${tool.name}\0${schema}`;
				if (this.fingerprints.get(name) === fingerprint) continue;
				const generation = this.generation;
				this.pi.registerTool({
					name, label: name, description: (tool.description ?? `MCP tool ${tool.name}`).slice(0, 2_000),
					parameters: Type.Unsafe(JSON.parse(schema)),
					execute: async (_id, args, signal) => {
						const current = this.runtime;
						if (!current || generation !== this.generation || !desired.has(name) || !selected(current.serverConfigs.get(server.name)?.directTools, current.config.settings.directTools ?? false, tool.name) || !current.manager.modelTool(server.name, tool.name)) throw new Error("MCP direct tool is no longer available");
						return current.executeDirect(server.name, tool.name, args as Record<string, unknown>, signal);
					},
				});
				this.owned.add(name); this.fingerprints.set(name, fingerprint); existing.add(name);
			}
		}
		this.setActivation(desired);
	}

	private setActivation(desired: Set<string>): void {
		const active = new Set(this.pi.getActiveTools());
		for (const name of this.owned) desired.has(name) ? active.add(name) : active.delete(name);
		this.pi.setActiveTools([...active]);
	}
}
