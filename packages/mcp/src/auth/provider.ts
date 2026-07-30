import { randomBytes } from "node:crypto";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthStore } from "./store.js";

export class StoredOAuthProvider implements OAuthClientProvider {
	private authorization?: URL;
	constructor(readonly identity: string, private readonly store: OAuthStore, private readonly callback?: string, private readonly expectedState?: string) {}
	static async passive(identity: string, store: OAuthStore): Promise<StoredOAuthProvider | undefined> {
		const record = await store.read(identity);
		if (!record?.client || !record.tokens || !record.clientRedirectUri || record.tokenClientId !== record.client.client_id) return undefined;
		return new StoredOAuthProvider(identity, store, record.clientRedirectUri);
	}
	get redirectUrl(): string | undefined { return this.callback; }
	get clientMetadata(): OAuthClientMetadata { return { client_name: "Pi MCP", redirect_uris: this.callback ? [this.callback] : [], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; }
	async state(): Promise<string> { const state = this.expectedState ?? randomBytes(32).toString("base64url"); await this.store.update(this.identity, (r) => { r.state = state; }); return state; }
	private consistent(record: Awaited<ReturnType<OAuthStore["read"]>>): boolean {
		return !!record?.client && typeof record.client.client_id === "string" &&
			(this.callback === undefined || record.clientRedirectUri === this.callback);
	}
	async clientInformation(): Promise<OAuthClientInformationMixed | undefined> { const r = await this.store.read(this.identity); return this.consistent(r) ? r!.client : undefined; }
	async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
		await this.store.update(this.identity, (r) => {
			if (r.client?.client_id !== client.client_id || r.clientRedirectUri !== this.callback) {
				delete r.tokens;
				delete r.tokenClientId;
			}
			r.client = client;
			r.clientRedirectUri = this.callback;
		});
	}
	async tokens(): Promise<OAuthTokens | undefined> { const r = await this.store.read(this.identity); return this.consistent(r) && r!.tokenClientId === r!.client!.client_id ? r!.tokens : undefined; }
	async saveTokens(tokens: OAuthTokens): Promise<void> { await this.store.update(this.identity, (r) => { if (!this.consistent(r)) throw new Error("OAuth client registration unavailable"); r.tokens = tokens; r.tokenClientId = r.client!.client_id; }); }
	async redirectToAuthorization(url: URL): Promise<void> { this.authorization = new URL(url); }
	takeAuthorizationUrl(): URL | undefined { return this.authorization && new URL(this.authorization); }
	async saveCodeVerifier(verifier: string): Promise<void> { await this.store.update(this.identity, (r) => { r.verifier = verifier; }); }
	async codeVerifier(): Promise<string> { const value = (await this.store.read(this.identity))?.verifier; if (!value) throw new Error("OAuth verifier unavailable"); return value; }
	async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> { await this.store.update(this.identity, (r) => { r.discovery = discovery; }); }
	async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return (await this.store.read(this.identity))?.discovery; }
	async clearFlowMaterial(): Promise<void> {
		await this.store.update(this.identity, (record) => {
			delete record.verifier;
			delete record.state;
		});
	}
	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		await this.store.update(this.identity, (r) => {
			if (scope === "all" || scope === "client") { delete r.client; delete r.clientRedirectUri; }
			if (scope === "all" || scope === "tokens" || scope === "client") { delete r.tokens; delete r.tokenClientId; }
			if (scope === "all" || scope === "verifier") delete r.verifier;
			if (scope === "all" || scope === "discovery") delete r.discovery;
			if (scope === "all") delete r.state;
		});
	}
}
