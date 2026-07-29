import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import type { AppPublicationStatus } from "./publisher.js";

const safeUrl = (value: string): string | undefined => {
	try {
		const url = new URL(value);
		return url.protocol === "https:" && !url.username && !url.password && !/[\u0000-\u001f\u007f]/.test(value) && value.length <= 2048 ? url.href : undefined;
	} catch { return undefined; }
};

export function appStatusText(status: AppPublicationStatus, hyperlinks = getCapabilities().hyperlinks): string | undefined {
	const url = status.url && safeUrl(status.url);
	if (!url || status.count < 1) return undefined;
	const label = `MCP UI ↗ ${status.count}`;
	if (hyperlinks) return hyperlink(label, url);
	return url.length <= 120 ? `${label} ${url}` : label;
}
