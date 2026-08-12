import assert from "node:assert/strict";
import test from "node:test";
import { registerGatewayCommand, type GatewayCommandDependencies, type GatewayOperations, type GatewayTailscale } from "../src/commands.js";
import { DEFAULT_UI_SETTINGS, type McpConfig, type McpGatewaySettings } from "../src/config.js";
import { safeAuthorizationUrl } from "../src/auth/coordinator.js";
import { TailscaleMutationError } from "../src/tailscale.js";

interface Notification { message: string; level: string; }

function config(gateway?: McpGatewaySettings): McpConfig {
	return { mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS }, gateway }, diagnostics: [] };
}

function harness(options: {
	action?: "t" | "c" | "d" | "x";
	gateway?: McpGatewaySettings;
	route?: "absent" | "matching" | "conflicting";
	verifyError?: Error;
	mode?: "tui" | "rpc";
	confirm?: boolean;
	inputs?: string[];
	quiesceError?: Error;
	writerError?: Error;
	writerCommitThenReject?: Error;
	setupErrorAfterMutation?: boolean;
	serialize?: boolean;
} = {}) {
	const calls: string[] = [];
	const writes: Array<McpGatewaySettings | undefined> = [];
	const notifications: Notification[] = [];
	let handler: ((argumentsText: string, context: any) => Promise<void>) | undefined;
	let route = options.route ?? "absent";
	let currentGateway = options.gateway;
	const tailscale: GatewayTailscale = {
		async status() { calls.push("status"); return { state: route, target: "http://127.0.0.1:19877" }; },
		async hostname() { calls.push("hostname"); return "node.ts.net"; },
		async setup() {
			calls.push("setup");
			const changed = route !== "matching";
			route = "matching";
			if (options.setupErrorAfterMutation) throw new TailscaleMutationError("setup", true);
			return { state: "matching", changed };
		},
		async remove() {
			calls.push("remove");
			const changed = route === "matching";
			route = "absent";
			return { state: "absent", changed };
		},
	};
	const client: GatewayOperations = {
		async ensure() { calls.push("ensure"); },
		async hello() { calls.push("hello"); },
		async shutdown() { calls.push("shutdown"); },
		async verify() { calls.push("verify"); if (options.verifyError) throw options.verifyError; },
	};
	let queue: Promise<unknown> = Promise.resolve();
	const dependencies: GatewayCommandDependencies = {
		tailscale,
		clientFactory: () => client,
		configLoader: () => config(currentGateway),
		writer: async (gateway) => {
			calls.push(`write:${gateway?.mode ?? "none"}`);
			if (options.writerError) throw options.writerError;
			writes.push(gateway);
			currentGateway = gateway;
			if (options.writerCommitThenReject) throw options.writerCommitThenReject;
		},
		quiesce: async () => { calls.push("quiesce"); if (options.quiesceError) throw options.quiesceError; },
	};
	if (options.serialize) dependencies.maintenance = <T>(operation: () => Promise<T>): Promise<T> => {
		const next = queue.catch(() => undefined).then(operation);
		queue = next;
		return next;
	};
	registerGatewayCommand({ registerCommand(_name: string, definition: { handler: typeof handler }) { handler = definition.handler; } } as never, dependencies);
	const inputs = [...(options.inputs ?? [])];
	const context = {
		mode: options.mode ?? "tui",
		ui: {
			theme: { fg: (_color: string, value: string) => value, bg: (_color: string, value: string) => value, bold: (value: string) => value },
			async custom(factory: any) {
				let result: any;
				const component = factory({ requestRender() {} }, this.theme, {}, (value: any) => { result = value; });
				component.handleInput(options.action ?? "t");
				return result;
			},
			async input() { return inputs.shift(); },
			async confirm() { calls.push("confirm"); return options.confirm ?? true; },
			notify(message: string, level: string) { notifications.push({ message, level }); },
		},
		async reload() { calls.push("reload"); },
	};
	return { calls, writes, notifications, run: async (args = "") => { assert.ok(handler); await handler(args, context); } };
}

test("OAuth authorization URLs allow HTTPS and loopback HTTP only", () => {
	assert.equal(safeAuthorizationUrl("https://auth.example/authorize?client_id=pi"), "https://auth.example/authorize?client_id=pi");
	assert.equal(safeAuthorizationUrl("http://127.0.0.1:1234/authorize"), "http://127.0.0.1:1234/authorize");
	for (const value of ["javascript:alert(1)", "http://remote.example/authorize", "https://user:pass@auth.example/", "https://auth.example/#token"]) assert.throws(() => safeAuthorizationUrl(value), /unsafe/);
});

test("panel-only Tailscale setup quiesces, externally validates, then persists", async () => {
	const subject = harness({ action: "t", route: "absent" });
	await subject.run("doctor --ignored");
	assert.deepEqual(subject.calls, ["quiesce", "shutdown", "ensure", "setup", "verify", "write:tailscale", "reload"]);
	assert.deepEqual(subject.writes, [{ mode: "tailscale" }]);
	assert.match(subject.notifications[0]?.message ?? "", /externally validated/);
});

test("custom setup accepts canonical HTTPS input, never invokes Tailscale, and persists only after verification", async () => {
	const subject = harness({ action: "c", inputs: ["https://mcp.example.test/apps/", "0.0.0.0"], confirm: true });
	await subject.run();
	assert.deepEqual(subject.calls, ["confirm", "quiesce", "shutdown", "ensure", "verify", "write:custom", "reload"]);
	assert.deepEqual(subject.writes, [{ mode: "custom", externalUrl: "https://mcp.example.test/apps", listenAddress: "0.0.0.0" }]);
});

test("failed external validation never saves and rolls back only a newly created Tailscale route", async () => {
	const created = harness({ action: "t", route: "absent", verifyError: new Error("SECRET") });
	await created.run();
	assert.deepEqual(created.calls, ["quiesce", "shutdown", "ensure", "setup", "verify", "shutdown", "remove", "reload"]);
	assert.deepEqual(created.writes, []);
	assert.doesNotMatch(JSON.stringify(created.notifications), /SECRET/);

	const existing = harness({ action: "t", route: "matching", verifyError: new Error("SECRET") });
	await existing.run();
	assert.ok(!existing.calls.includes("remove"));
	assert.deepEqual(existing.writes, []);
});

test("setup mutation failures roll back using adapter-reported ownership", async () => {
	const subject = harness({ action: "t", route: "absent", setupErrorAfterMutation: true });
	await subject.run();
	assert.deepEqual(subject.calls, ["quiesce", "shutdown", "ensure", "setup", "shutdown", "remove", "reload"]);
	assert.deepEqual(subject.writes, []);
});

test("quiesce failure reloads without touching the daemon", async () => {
	const subject = harness({ action: "t", quiesceError: new Error("SECRET") });
	await subject.run();
	assert.deepEqual(subject.calls, ["quiesce", "reload"]);
	assert.deepEqual(subject.writes, []);
	assert.doesNotMatch(JSON.stringify(subject.notifications), /SECRET/);
});

test("diagnose validates without quiescing, while custom removal clears only Pi configuration", async () => {
	const gateway = { mode: "custom", externalUrl: "https://mcp.example.test", listenAddress: "127.0.0.1" } as const;
	const diagnosed = harness({ action: "d", gateway });
	await diagnosed.run();
	assert.deepEqual(diagnosed.calls, ["verify"]);

	const removed = harness({ action: "x", gateway, confirm: true });
	await removed.run();
	assert.deepEqual(removed.calls, ["confirm", "quiesce", "shutdown", "write:none", "reload"]);
	assert.deepEqual(removed.writes, [undefined]);
	assert.match(removed.notifications[0]?.message ?? "", /external proxy separately/);
});

test("writer failure after Tailscale removal restores only an adapter-reported change", async () => {
	const gateway = { mode: "tailscale" } as const;
	const subject = harness({ action: "x", gateway, route: "matching", writerError: new Error("SECRET") });
	await subject.run();
	assert.deepEqual(subject.calls, ["confirm", "quiesce", "shutdown", "remove", "write:none", "setup", "reload"]);
	assert.deepEqual(subject.writes, []);
	assert.doesNotMatch(JSON.stringify(subject.notifications), /SECRET/);
});

test("committed gateway settings survive a writer rejection without infrastructure rollback", async () => {
	const setup = harness({ action: "t", route: "absent", writerCommitThenReject: new Error("POST_COMMIT_SECRET") });
	await setup.run();
	assert.deepEqual(setup.calls, ["quiesce", "shutdown", "ensure", "setup", "verify", "write:tailscale", "reload"]);
	assert.deepEqual(setup.writes, [{ mode: "tailscale" }]);
	assert.match(setup.notifications[0]?.message ?? "", /configured and externally validated/);
	assert.doesNotMatch(JSON.stringify(setup.notifications), /POST_COMMIT_SECRET/);

	const gateway = { mode: "tailscale" } as const;
	const removal = harness({ action: "x", gateway, route: "matching", writerCommitThenReject: new Error("POST_COMMIT_SECRET") });
	await removal.run();
	assert.deepEqual(removal.calls, ["confirm", "quiesce", "shutdown", "remove", "write:none", "reload"]);
	assert.deepEqual(removal.writes, [undefined]);
	assert.match(removal.notifications[0]?.message ?? "", /deactivated/);
	assert.doesNotMatch(JSON.stringify(removal.notifications), /POST_COMMIT_SECRET/);
});

test("maintenance wrapper serializes concurrent gateway transactions", async () => {
	const subject = harness({ action: "t", serialize: true });
	await Promise.all([subject.run(), subject.run()]);
	const transaction = ["quiesce", "shutdown", "ensure", "setup", "verify", "write:tailscale", "reload"];
	assert.deepEqual(subject.calls, [...transaction, ...transaction]);
});

test("non-TUI use rejects every legacy argument without mutation", async () => {
	for (const argument of ["", "setup", "doctor", "remove --yes"]) {
		const subject = harness({ mode: "rpc" });
		await subject.run(argument);
		assert.deepEqual(subject.calls, []);
		assert.match(subject.notifications[0]?.message ?? "", /interactive Pi TUI/);
	}
});
