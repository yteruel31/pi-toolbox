import { chmod } from "node:fs/promises";
import { piMcpAdapterConfigPath } from "../state/paths.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { McpServerConfig } from "./types.js";

export type PiMcpAdapterConfig = Record<string, unknown> & {
	mcpServers?: Record<string, McpServerConfig>;
};

export async function readPiMcpAdapterConfig(): Promise<PiMcpAdapterConfig> {
	const config = await readJsonFile<PiMcpAdapterConfig>(piMcpAdapterConfigPath(), { mcpServers: {} });
	return {
		...config,
		mcpServers: config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers) ? config.mcpServers : {},
	};
}

export async function writePiMcpAdapterConfig(config: PiMcpAdapterConfig): Promise<void> {
	const path = piMcpAdapterConfigPath();
	await writeJsonFile(path, config);
	await chmod(path, 0o600);
}
