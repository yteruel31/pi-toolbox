import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type PrerequisiteStatus = {
	name: string;
	required: boolean;
	installed: boolean;
	toolName?: string;
	installCommand: string;
	description: string;
};

const REQUIRED_PACKAGES = [
	{
		name: "pi-ask-user",
		toolName: "ask_user",
		installCommand: "pi install npm:pi-ask-user",
		description: "Required for consent prompts, trust decisions, and Claude ask-style permission decisions.",
	},
	{
		name: "pi-subagents",
		toolName: "subagent",
		installCommand: "pi install npm:pi-subagents",
		description: "Required for Claude agent compatibility and SubagentStart/SubagentStop lifecycle hooks.",
	},
] as const;

const OPTIONAL_PACKAGES = [
	{
		name: "pi-mcp-adapter",
		toolName: "mcp",
		installCommand: "pi install npm:pi-mcp-adapter",
		description: "Optional MCP bridge for Claude plugin .mcp.json files.",
	},
] as const;

export function checkPiPackages(pi: ExtensionAPI): PrerequisiteStatus[] {
	const tools = new Set(pi.getAllTools().map((tool) => tool.name));

	return [
		...REQUIRED_PACKAGES.map((pkg) => ({
			...pkg,
			required: true,
			installed: tools.has(pkg.toolName),
		})),
		...OPTIONAL_PACKAGES.map((pkg) => ({
			...pkg,
			required: false,
			installed: tools.has(pkg.toolName),
		})),
	];
}

export function missingRequiredPackages(statuses: PrerequisiteStatus[]): PrerequisiteStatus[] {
	return statuses.filter((status) => status.required && !status.installed);
}

