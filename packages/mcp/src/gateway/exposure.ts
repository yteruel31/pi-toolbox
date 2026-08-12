import type { McpUiSettings } from "../config.js";
import type { TailscaleAdapter } from "../tailscale.js";
import type { GatewayClient } from "./client.js";

/** Verifies that the configured external publication path reaches this gateway. */
export interface GatewayExposure {
	verify(): Promise<void>;
}

export class TailscaleGatewayExposure implements GatewayExposure {
	constructor(
		private readonly settings: McpUiSettings,
		private readonly tailscale: Pick<TailscaleAdapter, "status">,
		private readonly gateway: Pick<GatewayClient, "verify">,
	) {}

	async verify(): Promise<void> {
		if ((await this.tailscale.status(this.settings)).state !== "matching") throw new Error("MCP gateway is not configured");
		await this.gateway.verify();
	}
}

export class CustomGatewayExposure implements GatewayExposure {
	constructor(private readonly gateway: Pick<GatewayClient, "verify">) {}
	verify(): Promise<void> { return this.gateway.verify(); }
}
