import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { checkPiPackages, missingRequiredPackages, type PrerequisiteStatus } from "../prerequisites/check-pi-packages.js";

function formatStatus(status: PrerequisiteStatus): string {
	const marker = status.installed ? "✓" : status.required ? "✗" : "○";
	const requirement = status.required ? "required" : "optional";
	return `${marker} ${status.name} (${requirement}) — ${status.description}`;
}

export function buildDoctorReport(statuses: PrerequisiteStatus[]): string {
	const missing = missingRequiredPackages(statuses);

	const lines = [
		"Claude Marketplace for Pi",
		"",
		"Required and optional Pi packages:",
		...statuses.map(formatStatus),
	];

	if (missing.length > 0) {
		lines.push("", "Missing required packages:", ...missing.map((status) => `  ${status.installCommand}`));
		lines.push("", "Most /claude-marketplace-* actions are disabled until these packages are installed and Pi is restarted or reloaded.");
	} else {
		lines.push("", "All required packages are installed.");
	}

	return lines.join("\n");
}

export function showDoctor(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const statuses = checkPiPackages(pi);
	ctx.ui.notify(buildDoctorReport(statuses), missingRequiredPackages(statuses).length > 0 ? "warning" : "info");
	return Promise.resolve();
}
