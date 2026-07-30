import assert from "node:assert/strict";
import test from "node:test";
import { registerGatewayCommand, type GatewayProbe, type GatewayTailscale } from "../src/commands.js";
import { DEFAULT_UI_SETTINGS, type McpConfig } from "../src/config.js";
import { GatewayIncompatibleError, GatewayUnavailableError } from "../src/gateway/client.js";

interface Notification {
	message: string;
	level: string;
}

function config(): McpConfig {
	return {
		mcpServers: {},
		settings: { ui: { ...DEFAULT_UI_SETTINGS } },
		diagnostics: [],
	};
}

function harness(options: {
	confirm?: boolean;
	probeError?: Error;
	tailscaleError?: Error;
} = {}) {
	const calls: string[] = [];
	const notifications: Notification[] = [];
	let handler: ((argumentsText: string, context: any) => Promise<void>) | undefined;
	const tailscale: GatewayTailscale = {
		async status() {
			calls.push("status");
			if (options.tailscaleError) throw options.tailscaleError;
			return { state: "matching", target: "http://127.0.0.1:19877" };
		},
		async hostname() {
			calls.push("hostname");
			if (options.tailscaleError) throw options.tailscaleError;
			return "node.ts.net";
		},
		async setup() {
			calls.push("setup");
			if (options.tailscaleError) throw options.tailscaleError;
		},
		async remove() {
			calls.push("remove");
			if (options.tailscaleError) throw options.tailscaleError;
		},
	};
	const probe: GatewayProbe = {
		async ensure() {
			calls.push("ensure");
			if (options.probeError) throw options.probeError;
		},
		async hello() {
			calls.push("hello");
			if (options.probeError) throw options.probeError;
		},
	};
	registerGatewayCommand({
		registerCommand(_name: string, definition: { handler: typeof handler }) {
			handler = definition.handler;
		},
	} as never, tailscale, () => probe, config);
	const context = {
		ui: {
			async confirm() {
				calls.push("confirm");
				return options.confirm ?? false;
			},
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};
	return {
		calls,
		notifications,
		run: async (argumentsText: string) => {
			assert.ok(handler);
			await handler(argumentsText, context);
		},
	};
}

test("setup resolves the hostname, starts the gateway, and configures Serve", async () => {
	const subject = harness();
	await subject.run("setup");
	assert.deepEqual(subject.calls, ["hostname", "ensure", "setup"]);
	assert.match(subject.notifications[0]?.message ?? "", /configured/);
});

test("doctor probes without starting or mutating and distinguishes gateway states", async () => {
	for (const [error, expected] of [
		[undefined, "compatible"],
		[new GatewayIncompatibleError("details"), "incompatible"],
		[new GatewayUnavailableError("details"), "unreachable"],
	] as const) {
		const subject = harness({ probeError: error });
		await subject.run("doctor");
		assert.deepEqual(subject.calls, ["status", "hostname", "hello"]);
		assert.match(subject.notifications[0]?.message ?? "", new RegExp(`Gateway: ${expected}`));
		assert.ok(!subject.calls.includes("ensure"));
		assert.ok(!subject.calls.includes("setup"));
	}
});

test("remove requires confirmation unless --yes is supplied", async () => {
	const cancelled = harness({ confirm: false });
	await cancelled.run("remove");
	assert.deepEqual(cancelled.calls, ["confirm"]);
	assert.match(cancelled.notifications[0]?.message ?? "", /cancelled/);

	const confirmed = harness({ confirm: true });
	await confirmed.run("remove");
	assert.deepEqual(confirmed.calls, ["confirm", "remove"]);

	const forced = harness();
	await forced.run("remove --yes");
	assert.deepEqual(forced.calls, ["remove"]);
});

test("command failures are action-specific and never echo arbitrary error text", async () => {
	const secret = "SUPERSECRET_FROM_COMMAND";
	const setup = harness({ probeError: new Error(secret) });
	await setup.run("setup");
	assert.match(setup.notifications[0]?.message ?? "", /setup failed/);
	assert.doesNotMatch(JSON.stringify(setup.notifications), new RegExp(secret));

	const doctor = harness({ tailscaleError: new Error(secret) });
	await doctor.run("doctor");
	assert.match(doctor.notifications[0]?.message ?? "", /doctor failed/);
	assert.match(doctor.notifications[0]?.message ?? "", /Check Tailscale/);
	assert.doesNotMatch(JSON.stringify(doctor.notifications), new RegExp(secret));
});
