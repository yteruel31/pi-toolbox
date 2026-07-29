import type { McpUiSettings } from "../config.js";
import type { GatewayClient } from "../gateway/client.js";
import type { Session } from "../gateway/protocol.js";
import type { TailscaleAdapter } from "../tailscale.js";
import type { LocalAppDescriptor } from "./controller.js";

export interface AppPublicationStatus {
	state: "available" | "unavailable";
	url?: string;
	count: number;
}

export interface AppPublisherOptions {
	settings: McpUiSettings;
	gateway: Pick<GatewayClient, "register" | "update" | "heartbeat" | "unregister">;
	tailscale: Pick<TailscaleAdapter, "status">;
	backend: () => { origin: string; secret: string } | undefined;
	onStatus?: (status?: AppPublicationStatus) => void;
	heartbeatMs?: number;
	operationTimeoutMs?: number;
}

export function appHeartbeatInterval(settings: McpUiSettings): number {
	return Math.max(1, Math.min(60_000, Math.floor(settings.idleTimeoutMs / 3) || 1));
}

/** Serializes the single private capability lease owned by one Pi runtime. */
export class AppPublisher {
	private apps: readonly LocalAppDescriptor[] = [];
	private session?: Session;
	private publishedLabel?: string;
	private work: Promise<AppPublicationStatus> = Promise.resolve({ state: "unavailable", count: 0 });
	private timer?: NodeJS.Timeout;
	private closed = false;

	constructor(private readonly options: AppPublisherOptions) {}

	reconcile(apps: readonly LocalAppDescriptor[]): Promise<AppPublicationStatus> {
		this.apps = apps.map((app) => ({ ...app }));
		const result = this.enqueue(() => this.apply());
		void result.then(() => this.ensureTimer(), () => this.ensureTimer());
		return result;
	}

	private enqueue(task: () => Promise<AppPublicationStatus>): Promise<AppPublicationStatus> {
		const result = this.work.then(task, task);
		this.work = result.catch(() => ({ state: "unavailable", count: this.apps.length }));
		return result;
	}

	private label(): string {
		const labels = this.apps.slice(0, 3).map((app) =>
			app.label.replace(/[\u0000-\u001f\u007f]/gu, "").slice(0, 50));
		return (`MCP Apps (${this.apps.length})${labels.length ? ` — ${labels.join(", ")}` : ""}`).slice(0, 200);
	}

	private status(): AppPublicationStatus {
		return this.session
			? { state: "available", url: this.session.externalUrl, count: this.apps.length }
			: { state: "unavailable", count: this.apps.length };
	}

	private notify(status?: AppPublicationStatus): void {
		try { this.options.onStatus?.(status); }
		catch { /* A UI renderer failure must not revoke a valid gateway lease. */ }
	}

	private async operation<T>(task: () => Promise<T>): Promise<T> {
		let rejectTimeout!: (error: Error) => void;
		const timeoutFailure = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
		const timeout = setTimeout(
			() => rejectTimeout(new Error("App publication operation timed out")),
			this.options.operationTimeoutMs ?? 6_000,
		);
		try { return await Promise.race([Promise.resolve().then(task), timeoutFailure]); }
		finally { clearTimeout(timeout); }
	}

	private async apply(): Promise<AppPublicationStatus> {
		if (this.closed || !this.apps.length) {
			await this.remove(true);
			this.notify(undefined);
			return { state: "unavailable", count: 0 };
		}

		try {
			if (!this.session) {
				const route = await this.operation(() => this.options.tailscale.status(this.options.settings));
				if (route.state !== "matching") throw new Error("route unavailable");
				const backend = this.options.backend();
				if (!backend) throw new Error("backend unavailable");
				if (this.closed || !this.apps.length) return { state: "unavailable", count: this.apps.length };
				const label = this.label();
				this.session = await this.operation(() => this.options.gateway.register({
					label,
					backendOrigin: backend.origin,
					backendSecret: backend.secret,
				}));
				this.publishedLabel = label;
				if (this.closed || !this.apps.length) {
					await this.remove(true);
					return { state: "unavailable", count: 0 };
				}
			} else {
				const label = this.label();
				if (label !== this.publishedLabel) {
					const current = this.session;
					this.session = await this.operation(() => this.options.gateway.update(current, label));
					this.publishedLabel = label;
				}
			}
			const status = this.status();
			this.notify(status);
			return status;
		} catch {
			await this.remove(false);
			this.notify(undefined);
			return { state: "unavailable", count: this.apps.length };
		}
	}

	private ensureTimer(): void {
		if (this.timer || this.closed || !this.apps.length) return;
		const configured = this.options.heartbeatMs;
		const interval = configured ?? appHeartbeatInterval(this.options.settings);
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const maintenance = this.enqueue(async () => {
				if (this.closed || !this.apps.length) return this.apply();
				if (!this.session) return this.apply();
				try {
					const current = this.session;
					this.session = await this.operation(() => this.options.gateway.heartbeat(current));
					const status = this.status();
					this.notify(status);
					return status;
				} catch {
					await this.remove(false);
					this.notify(undefined);
					return this.apply();
				}
			});
			void maintenance.then(() => this.ensureTimer(), () => this.ensureTimer());
		}, interval);
		this.timer.unref();
	}

	private async remove(stopTimer: boolean): Promise<void> {
		if (stopTimer && this.timer) clearTimeout(this.timer);
		if (stopTimer) this.timer = undefined;
		const session = this.session;
		this.session = undefined;
		this.publishedLabel = undefined;
		if (session) {
			try { await this.operation(() => this.options.gateway.unregister(session)); }
			catch { /* The abandoned capability still expires unless its lease is renewed. */ }
		}
	}

	async close(): Promise<void> {
		if (this.closed) return this.work.then(() => undefined);
		this.closed = true;
		this.apps = [];
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		await this.enqueue(async () => {
			await this.remove(true);
			this.notify(undefined);
			return { state: "unavailable", count: 0 };
		});
	}
}
