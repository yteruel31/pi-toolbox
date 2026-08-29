import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export function gatewayControlEndpoint(directory: string, platform: NodeJS.Platform = process.platform): string {
	if (platform !== "win32") return join(directory, "control.sock");
	const identity = resolve(directory).replaceAll("\\", "/").toLowerCase();
	const suffix = createHash("sha256").update(identity).digest("hex").slice(0, 24);
	return `\\\\.\\pipe\\pi-mcp-${suffix}`;
}

export function isFilesystemControlEndpoint(endpoint: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32" || !endpoint.startsWith("\\\\.\\pipe\\");
}
