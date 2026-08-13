import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BrowserCommand {
	command: string;
	args: string[];
}

export function browserCommand(url: string, platform = process.platform): BrowserCommand {
	switch (platform) {
		case "darwin": return { command: "open", args: [url] };
		case "win32": return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
		default: return { command: "xdg-open", args: [url] };
	}
}

export async function openBrowser(url: string): Promise<void> {
	const invocation = browserCommand(url);
	await execFileAsync(invocation.command, invocation.args, {
		timeout: 3_000,
		windowsHide: true,
	});
}
