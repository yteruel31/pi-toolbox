import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { McpUiSettings } from "./config.js";

const execFile = promisify(execFileCallback);
export interface TailscaleExec { (args: readonly string[]): Promise<{ stdout: string }> }
export type RouteState = "absent" | "matching" | "conflicting";

const TAILSCALE_TIMEOUT_MS = 5_000;
export class TailscaleAdapter {
	constructor(private readonly run: TailscaleExec = async (args) => execFile("tailscale", [...args], {
		encoding: "utf8",
		timeout: TAILSCALE_TIMEOUT_MS,
		killSignal: "SIGKILL",
	})) {}

	async status(settings: McpUiSettings): Promise<{ state: RouteState; target: string }> {
		const target = `http://127.0.0.1:${settings.gatewayPort}`;
		let stdout: string;
		try { ({ stdout } = await this.run(["serve", "status", "--json"])); }
		catch { throw new Error("Tailscale is unavailable"); }
		let data: unknown;
		try { data = JSON.parse(stdout); }
		catch { throw new Error("Malformed Tailscale Serve status"); }
		const configured = selectedHandler(data, settings.httpsPort, settings.basePath);
		const state: RouteState = configured === undefined ? "absent" : configured === target ? "matching" : "conflicting";
		return { state, target };
	}

	async hostname(): Promise<string | undefined> {
		let stdout: string;
		try { ({ stdout } = await this.run(["status", "--json"])); }
		catch { throw new Error("Tailscale is unavailable"); }
		try {
			const data = JSON.parse(stdout);
			const name = data?.Self?.DNSName;
			if (name === undefined) return undefined;
			if (typeof name !== "string" || !name.trim()) throw new Error();
			return name.replace(/\.$/, "");
		} catch { throw new Error("Malformed Tailscale status"); }
	}

	async setup(settings: McpUiSettings): Promise<RouteState> {
		const status = await this.status(settings);
		if (status.state === "conflicting") throw new Error("Tailscale Serve route is owned by another target");
		if (status.state === "absent") await this.safeRun(["serve", "--bg", `--https=${settings.httpsPort}`, `--set-path=${settings.basePath}`, status.target]);
		return status.state;
	}

	async remove(settings: McpUiSettings): Promise<RouteState> {
		const status = await this.status(settings);
		if (status.state === "conflicting") throw new Error("Refusing to remove a route owned by another target");
		if (status.state === "matching") await this.safeRun(["serve", `--https=${settings.httpsPort}`, `--set-path=${settings.basePath}`, "off"]);
		return status.state;
	}

	private async safeRun(args: readonly string[]): Promise<void> {
		try { await this.run(args); }
		catch { throw new Error("Tailscale command failed"); }
	}
}

function selectedHandler(value: unknown, port: number, basePath: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const web = (value as { Web?: unknown }).Web;
	if (!web || typeof web !== "object") return undefined;
	const route = `${basePath.replace(/\/+$/, "")}/`;
	const selected: string[] = [];
	for (const [hostPort, server] of Object.entries(web)) {
		if (!hostPort.endsWith(`:${port}`) || !server || typeof server !== "object") continue;
		const handlers = (server as { Handlers?: unknown }).Handlers;
		if (!handlers || typeof handlers !== "object") continue;
		const handler = (handlers as Record<string, unknown>)[route];
		if (handler === undefined) continue;
		if (!handler || typeof handler !== "object") selected.push("<conflicting>");
		else {
			const proxy = (handler as { Proxy?: unknown }).Proxy;
			selected.push(typeof proxy === "string" ? proxy : "<conflicting>");
		}
	}
	if (selected.length === 0) return undefined;
	return selected.every((handler) => handler === selected[0]) ? selected[0] : "<conflicting>";
}
