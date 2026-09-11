import assert from "node:assert/strict";
import test from "node:test";
import { GatewayConfiguration, gatewayAgentPrompt, type GatewayCommandDependencies, type GatewayOperations, type GatewayTailscale } from "../src/commands.js";
import { DEFAULT_UI_SETTINGS, type McpConfig, type McpGatewaySettings } from "../src/config.js";
import { safeAuthorizationUrl } from "../src/auth/coordinator.js";
import { GatewayDiagnosticError } from "../src/gateway/diagnostics.js";
import { TailscaleMutationError } from "../src/tailscale.js";
import { registerMcpTool } from "../src/runtime.js";

function config(gateway?: McpGatewaySettings): McpConfig {
	return { mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS }, gateway }, diagnostics: [] };
}
function harness(options: {
	gateway?: McpGatewaySettings;
	route?: "absent" | "matching" | "conflicting";
	verifyError?: Error;
	confirm?: boolean;
	hasUI?: boolean;
	quiesceError?: Error;
	writerError?: Error;
	writerCommitThenReject?: Error;
	setupErrorAfterMutation?: boolean;
	rollbackError?: Error;
	resumeError?: Error;
	shutdownError?: Error;
	ensureError?: Error;
	onConfirm?: () => void;
} = {}) {
	const calls: string[] = [];
	const writes: Array<McpGatewaySettings | undefined> = [];
	let route = options.route ?? "absent";
	let currentGateway = options.gateway;
	const tailscale: GatewayTailscale = {
		async status() { calls.push("status"); return { state: route, target: "http://127.0.0.1:19877" }; },
		async hostname() { return "node.ts.net"; },
		async setup() {
			calls.push("setup");
			if (route === "conflicting") throw new TailscaleMutationError("setup", false, "route-conflict");
			const changed = route !== "matching";
			route = "matching";
			if (options.setupErrorAfterMutation) throw new TailscaleMutationError("setup", true);
			return { state: "matching", changed };
		},
		async remove() {
			calls.push("remove");
			if (options.rollbackError) throw options.rollbackError;
			const changed = route === "matching";
			route = "absent";
			return { state: "absent", changed };
		},
	};
	const client: GatewayOperations = {
		async ensure() { calls.push("ensure"); if (options.ensureError) throw options.ensureError; },
		async hello() { calls.push("hello"); },
		async shutdown() { calls.push("shutdown"); if (options.shutdownError) throw options.shutdownError; },
		async verify() { calls.push("verify"); if (options.verifyError) throw options.verifyError; },
	};
	const settings: unknown[] = [];
	const dependencies: GatewayCommandDependencies = {
		tailscale,
		clientFactory: (_gateway, effective) => { settings.push(effective); return client; },
		configLoader: () => config(currentGateway),
		writer: async (gateway) => {
			calls.push(`write:${gateway?.mode ?? "none"}`);
			if (options.writerError) throw options.writerError;
			writes.push(gateway);
			currentGateway = gateway;
			if (options.writerCommitThenReject) throw options.writerCommitThenReject;
		},
		quiesce: async () => { calls.push("quiesce"); if (options.quiesceError) throw options.quiesceError; },
		resume: async () => { calls.push("resume"); if (options.resumeError) throw options.resumeError; },
	};
	const context = { hasUI: options.hasUI ?? true, ui: {
		async confirm() { calls.push("confirm"); options.onConfirm?.(); return options.confirm ?? true; },
	} } as never;
	const service = new GatewayConfiguration(dependencies);
	return { calls, writes, service, context, settings, dependencies, setGateway: (gateway: McpGatewaySettings) => { currentGateway = gateway; },
		configure: (candidate: unknown = { mode: "tailscale" }, signal?: AbortSignal) => service.configure(candidate, context, signal),
		deactivate: () => service.deactivate(context) };
}
const custom = { mode: "custom", externalUrl: "https://mcp.example.test/apps", listenAddress: "127.0.0.1" } as const;
const transaction = ["confirm", "quiesce", "shutdown", "ensure", "setup", "verify", "write:tailscale", "resume"];

test("OAuth authorization URLs allow HTTPS and loopback HTTP only", () => {
	assert.equal(safeAuthorizationUrl("https://auth.example/authorize?client_id=pi"), "https://auth.example/authorize?client_id=pi");
	assert.equal(safeAuthorizationUrl("http://127.0.0.1:1234/authorize"), "http://127.0.0.1:1234/authorize");
	for (const value of ["javascript:alert(1)", "http://remote.example/authorize", "https://user:pass@auth.example/", "https://auth.example/#token"]) assert.throws(() => safeAuthorizationUrl(value), /unsafe/);
});
test("Tailscale setup confirms, quiesces, externally validates, then persists and restores runtime", async () => {
	const subject = harness();
	assert.equal((await subject.configure()).persisted, true);
	assert.deepEqual(subject.calls, transaction);
	assert.deepEqual(subject.writes, [{ mode: "tailscale" }]);
	assert.equal((subject.settings[0] as any).requireTailscaleIdentity, true);
});
test("custom setup canonicalizes input, never invokes Tailscale, and persists only after verification", async () => {
	const subject = harness();
	await subject.configure({ ...custom, externalUrl: `${custom.externalUrl}/`, listenAddress: "0.0.0.0" });
	assert.deepEqual(subject.calls, ["confirm", "quiesce", "shutdown", "ensure", "verify", "write:custom", "resume"]);
	assert.deepEqual(subject.writes, [{ ...custom, listenAddress: "0.0.0.0" }]);
	assert.equal((subject.settings[0] as any).basePath, "/apps");
	assert.equal((subject.settings[0] as any).requireTailscaleIdentity, false);
});
test("invalid candidate, missing interactive UI, declined confirmation and abort don't mutate", async () => {
	for (const candidate of [undefined, { mode: "foo" }, { ...custom, externalUrl: "http://bad" }, { ...custom, secret: "SECRET" }, { ...custom, listenAddress: "localhost" }]) {
		const subject = harness();
		const report = await subject.service.configure(candidate, subject.context);
		assert.equal(report.diagnostic?.code, "invalid-config");
		assert.deepEqual(subject.calls, []);
	}
	for (const options of [{ confirm: false }, { hasUI: false }]) {
		const subject = harness(options);
		assert.equal((await subject.configure()).state, "cancelled");
		assert.ok(!subject.calls.includes("quiesce"));
	}
	const controller = new AbortController();
	const subject = harness({ onConfirm: () => controller.abort() });
	assert.equal((await subject.configure(custom, controller.signal)).diagnostic?.code, "cancelled");
	assert.deepEqual(subject.calls, ["confirm"]);
});
test("validation failure saves nothing and rolls back only a newly created Tailscale route", async () => {
	const created = harness({ verifyError: new Error("SECRET https://host/s/CAPABILITY/ auth=secret") });
	const report = await created.configure();
	assert.deepEqual(created.calls, ["confirm", "quiesce", "shutdown", "ensure", "setup", "verify", "shutdown", "remove", "resume"]);
	assert.equal(report.diagnostic?.step, "external-https");
	assert.equal(report.rollback, "completed");
	assert.deepEqual(created.writes, []);
	assert.doesNotMatch(JSON.stringify(report), /SECRET|CAPABILITY|auth=secret/);
	const existing = harness({ route: "matching", verifyError: new Error("SECRET") });
	await existing.configure();
	assert.ok(!existing.calls.includes("remove"));
});
test("partial route mutations are rolled back and failed rollback is actionable", async () => {
	const subject = harness({ setupErrorAfterMutation: true, rollbackError: new Error("SECRET") });
	const report = await subject.configure();
	assert.deepEqual(subject.calls, ["confirm", "quiesce", "shutdown", "ensure", "setup", "shutdown", "remove", "resume"]);
	assert.equal(report.rollback, "failed");
	assert.equal(report.persisted, false);
	assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});
test("quiesce, daemon shutdown and startup failures identify their step and restore runtime", async () => {
	for (const [options, step] of [
		[{ quiesceError: new Error("SECRET") }, "quiesce"],
		[{ shutdownError: new GatewayDiagnosticError("active-sessions") }, "daemon-stop"],
		[{ ensureError: new GatewayDiagnosticError("daemon-unavailable") }, "daemon-start"],
	] as const) {
		const subject = harness(options);
		const report = await subject.configure();
		assert.equal(report.diagnostic?.step, step);
		assert.deepEqual(subject.writes, []);
		assert.equal(subject.calls.at(-1), "resume");
		assert.doesNotMatch(JSON.stringify(report), /SECRET/);
	}
});
test("diagnose validates without quiescing; custom removal clears only Pi configuration", async () => {
	const diagnosed = harness({ gateway: custom });
	assert.equal(diagnosed.service.status().state, "configured");
	assert.deepEqual(diagnosed.calls, []);
	assert.equal((await diagnosed.service.validate()).state, "validated");
	assert.deepEqual(diagnosed.calls, ["verify"]);
	const removed = harness({ gateway: custom });
	assert.equal((await removed.deactivate()).previousInfrastructurePreserved, true);
	assert.deepEqual(removed.calls, ["confirm", "quiesce", "shutdown", "write:none", "resume"]);
	assert.deepEqual(removed.writes, [undefined]);
});
test("diagnostics distinguish absent and conflicting routes without mutation", async () => {
	for (const route of ["absent", "conflicting"] as const) {
		const subject = harness({ gateway: { mode: "tailscale" }, route });
		const report = await subject.service.validate();
		assert.equal(report.diagnostic?.code, route === "absent" ? "route-absent" : "route-conflict");
		assert.deepEqual(subject.calls, ["status"]);
	}
});
test("writer failure after Tailscale removal restores only an adapter-reported change", async () => {
	const subject = harness({ gateway: { mode: "tailscale" }, route: "matching", writerError: new Error("SECRET") });
	const report = await subject.deactivate();
	assert.deepEqual(subject.calls, ["confirm", "quiesce", "shutdown", "remove", "write:none", "setup", "resume"]);
	assert.equal(report.diagnostic?.code, "persistence-failed");
	assert.deepEqual(subject.writes, []);
});
test("committed settings survive post-commit rejection without infrastructure rollback", async () => {
	const setup = harness({ writerCommitThenReject: new Error("SECRET") });
	assert.equal((await setup.configure()).persisted, true);
	assert.deepEqual(setup.calls, transaction);
	const removal = harness({ gateway: { mode: "tailscale" }, route: "matching", writerCommitThenReject: new Error("SECRET") });
	assert.equal((await removal.deactivate()).persisted, true);
	assert.deepEqual(removal.calls, ["confirm", "quiesce", "shutdown", "remove", "write:none", "resume"]);
});
test("shared service serializes concurrent UI and agent transactions", async () => {
	const subject = harness();
	await Promise.all([subject.configure(), subject.configure()]);
	assert.deepEqual(subject.calls, [...transaction, ...transaction]);
});
test("switching modes preserves previous external infrastructure", async () => {
	const subject = harness({ gateway: { mode: "tailscale" }, route: "matching" });
	assert.equal((await subject.configure(custom)).previousInfrastructurePreserved, true);
	assert.ok(!subject.calls.includes("remove"));
});
test("changed configuration while confirming is rejected before quiescing", async () => {
	const subject = harness({ onConfirm: () => subject.setGateway(custom) });
	assert.equal((await subject.configure()).diagnostic?.code, "configuration-changed");
	assert.deepEqual(subject.calls, ["confirm"]);
});
test("runtime restore failure does not hide committed state or trigger rollback", async () => {
	const subject = harness({ resumeError: new Error("SECRET") });
	const report = await subject.configure();
	assert.equal(report.persisted, true);
	assert.equal(report.restoreDiagnostic?.code, "runtime-restore-failed");
	assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});
test("agent gateway actions use the same confirmed lifecycle and reject mixed input", async () => {
	const subject = harness();
	let tool: any;
	registerMcpTool({ registerTool: (value: unknown) => { tool = value; } } as never, () => ({}) as never, subject.service);
	const run = (input: unknown) => tool.execute("id", input, undefined, undefined, subject.context);
	const status = await run({ action: "gateway-status" });
	assert.equal(status.details.gateway.state, "unconfigured");
	assert.deepEqual(subject.calls, []);
	for (const input of [
		{ action: "gateway-configure", server: "bad", args: custom },
		{ action: "gateway-validate", args: {} },
		{ action: "gateway-deactivate", tool: "bad" },
	]) await assert.rejects(run(input));
	const result = await run({ action: "gateway-configure", args: custom });
	assert.equal(result.details.gateway.persisted, true);
	assert.deepEqual(subject.calls, ["confirm", "quiesce", "shutdown", "ensure", "verify", "write:custom", "resume"]);
});
test("invalid readback after a rejected removal is not treated as a committed postcondition", async () => {
	const subject = harness({ gateway: { mode: "tailscale" }, route: "matching" });
	let corrupted = false;
	const service = new GatewayConfiguration({ ...subject.dependencies,
		configLoader: () => corrupted ? { ...config(), diagnostics: [{ source: "SECRET", path: "$", code: "invalid-json", message: "SECRET" }] } : config({ mode: "tailscale" }),
		writer: async () => { corrupted = true; throw new Error("SECRET"); },
	});
	const report = await service.deactivate(subject.context);
	assert.equal(report.persisted, false);
	assert.equal(report.rollback, "completed");
	assert.ok(subject.calls.includes("setup"));
	assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test("abort or runtime replacement during shutdown never starts the candidate daemon", async () => {
	for (const kind of ["abort", "replace"]) {
		const subject = harness();
		const abort = new AbortController();
		let current = true;
		let started = false;
		const service = new GatewayConfiguration({ ...subject.dependencies, isCurrent: () => current,
			clientFactory: () => ({
				async shutdown() { await Promise.resolve(); if (kind === "abort") abort.abort(); else current = false; },
				async ensure() { started = true; }, async hello() {}, async verify() {},
			}),
		});
		const report = await service.configure({ mode: "tailscale" }, subject.context, abort.signal);
		assert.equal(started, false);
		assert.ok(!subject.calls.includes("setup"));
		assert.equal(report.persisted, false);
		assert.equal(report.diagnostic?.code, kind === "abort" ? "cancelled" : "runtime-changed");
	}
});

test("pre-commit cancellation of an unchanged gateway is not mistaken for a committed write", async () => {
	const subject = harness({ gateway: custom });
	const abort = new AbortController();
	const service = new GatewayConfiguration({ ...subject.dependencies,
		writer: async (_gateway, _expected, beforeCommit) => { abort.abort("SECRET reason"); beforeCommit(); },
	});
	const report = await service.configure(custom, subject.context, abort.signal);
	assert.equal(report.persisted, false);
	assert.equal(report.diagnostic?.code, "cancelled");
	assert.equal(report.rollback, "completed");
	assert.doesNotMatch(JSON.stringify(report), /SECRET/);
});

test("read-only validation does not report success for settings changed during the probe", async () => {
	const subject = harness({ gateway: custom });
	const service = new GatewayConfiguration({ ...subject.dependencies,
		clientFactory: () => ({ async ensure() {}, async hello() {}, async shutdown() {}, async verify() { subject.setGateway({ mode: "tailscale" }); } }),
	});
	assert.equal((await service.validate()).diagnostic?.code, "configuration-changed");
	assert.deepEqual(subject.writes, []);
});

test("cached validation remains tied to observed settings, not a later maintenance reload", async () => {
	const subject = harness({ gateway: custom });
	const service = new GatewayConfiguration({ ...subject.dependencies,
		maintenance: async (operation) => {
			const report = await operation();
			subject.setGateway({ mode: "tailscale" });
			return report;
		},
	});
	assert.equal((await service.validate()).state, "validated");
	assert.equal(service.latest().mode, "tailscale");
	assert.equal(service.latest().state, "configured");
});

test("writer conflict with the same candidate but a different port is not a verified commit", async () => {
	const subject = harness();
	let currentConfig = config();
	const service = new GatewayConfiguration({ ...subject.dependencies, configLoader: () => currentConfig,
		writer: async () => {
			currentConfig = config(custom);
			currentConfig.settings.ui.gatewayPort = 29999;
			throw new GatewayDiagnosticError("configuration-changed");
		},
	});
	const report = await service.configure(custom, subject.context);
	assert.equal(report.persisted, false);
	assert.equal(report.rollback, "completed");
	assert.equal(report.diagnostic?.code, "configuration-changed");
});

test("runtime replacement before persistence rolls back instead of saving stale settings", async () => {
	const subject = harness();
	let current = true;
	const service = new GatewayConfiguration({ ...subject.dependencies, isCurrent: () => current,
		clientFactory: () => ({ ensure: async () => {}, hello: async () => {}, shutdown: async () => {}, verify: async () => { current = false; } }),
	});
	const report = await service.configure({ mode: "tailscale" }, subject.context);
	assert.equal(report.diagnostic?.code, "runtime-changed");
	assert.equal(report.rollback, "completed");
	assert.deepEqual(subject.writes, []);
});

test("Custom and repair prompts use safe context and require agreement before infrastructure changes", async () => {
	const subject = harness({ verifyError: new GatewayDiagnosticError("tls-failed") });
	const report = await subject.configure();
	for (const kind of ["custom", "repair"] as const) {
		const prompt = gatewayAgentPrompt(kind, { ...report, diagnostic: { ...report.diagnostic!, summary: "SECRET", nextAction: "SECRET" } });
		assert.match(prompt, /current conversation/);
		assert.match(prompt, /explicit agreement/);
		assert.match(prompt, /gateway-configure/);
		assert.doesNotMatch(prompt, /SECRET/);
	}
	const prompt = gatewayAgentPrompt("custom", report);
	for (const choice of [/Traefik or another proxy/, /domain/, /public versus private/, /reuse.*install/]) assert.match(prompt, choice);
});
