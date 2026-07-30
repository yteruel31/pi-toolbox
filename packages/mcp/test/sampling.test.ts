import assert from "node:assert/strict";
import test from "node:test";
import { sample } from "../src/mcp/sampling.js";

function harness(confirmations: boolean[] = [true, true]) {
	const prompts: string[] = [];
	let completeCalls = 0;
	const model = { provider: "test", id: "model", name: "Test Model" };
	const context = {
		model,
		modelRegistry: {
			hasConfiguredAuth: () => true,
			getAvailable: () => [model],
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "private-key", headers: { Authorization: "private" } }),
		},
		ui: {
			confirm: async (_title: string, message: string) => { prompts.push(message); return confirmations.shift() ?? false; },
		},
		signal: undefined,
	} as never;
	const complete = async (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) => {
		completeCalls++;
		if (options.signal?.aborted) throw new Error("PROVIDER_ABORT_MARKER");
		return {
			role: "assistant",
			content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "sampled answer" }],
			provider: "test",
			model: "model",
			stopReason: "stop",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			timestamp: Date.now(),
		};
	};
	return { context, prompts, complete: complete as never, completeCalls: () => completeCalls };
}

const request = {
	systemPrompt: "server system prompt",
	messages: [{ role: "user", content: { type: "text", text: "server user content" } }],
	maxTokens: 128,
};

test("sampling requires two informed approvals and strips reasoning", async () => {
	const h = harness();
	const result = await sample("srv", request, h.context, false, undefined, h.complete);
	assert.equal((result.content as { text: string }).text, "sampled answer");
	assert.doesNotMatch(JSON.stringify(result), /reasoning|private-key|Authorization/);
	assert.equal(h.completeCalls(), 1);
	assert.equal(h.prompts.length, 2);
	assert.match(h.prompts[0]!, /server system prompt.*server user content/s);
	assert.match(h.prompts[1]!, /sampled answer/);
});

test("sampling auto-approval is explicit and declines before provider work", async () => {
	const automatic = harness([]);
	assert.match(JSON.stringify(await sample("srv", request, automatic.context, true, undefined, automatic.complete)), /sampled answer/);
	assert.deepEqual(automatic.prompts, []);

	const declined = harness([false]);
	await assert.rejects(sample("srv", request, declined.context, false, undefined, declined.complete), /sampling request was rejected/);
	assert.equal(declined.completeCalls(), 0);
});

test("sampling bounds hostile requests, observes cancellation, and redacts provider errors", async () => {
	const h = harness([]);
	await assert.rejects(sample("srv", { ...request, messages: Array.from({ length: 32 }, () => ({ role: "user", content: { type: "text", text: "x".repeat(3_000) } })) }, h.context, true, undefined, h.complete), /sampling request was rejected/);
	await assert.rejects(sample("srv", { ...request, toolChoice: { mode: "auto" } }, h.context, true, undefined, h.complete), /sampling request was rejected/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(sample("srv", request, h.context, true, controller.signal, h.complete), /sampling request was rejected/);
	const providerFailure = async () => { throw new Error("PROVIDER_SECRET_MARKER"); };
	await assert.rejects(sample("srv", request, h.context, true, undefined, providerFailure as never), (error: Error) => {
		assert.equal(error.message, "MCP sampling request was rejected");
		assert.doesNotMatch(JSON.stringify(error), /PROVIDER_SECRET_MARKER/);
		return true;
	});
});
