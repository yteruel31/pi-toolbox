import assert from "node:assert/strict";
import test from "node:test";
import { elicitForm } from "../src/mcp/elicitation.js";

function ui(options: { confirms?: boolean[]; selects?: Array<string | undefined>; inputs?: Array<string | undefined> } = {}) {
	const reviews: string[] = [];
	const confirms = [...(options.confirms ?? [true, true])];
	const selects = [...(options.selects ?? [])];
	const inputs = [...(options.inputs ?? [])];
	return {
		reviews,
		value: {
			confirm: async (_title: string, message: string) => { reviews.push(message); return confirms.shift() ?? false; },
			select: async () => selects.shift(),
			input: async () => inputs.shift(),
		},
	};
}

const form = {
	mode: "form",
	message: "Provide connection settings",
	requestedSchema: {
		type: "object",
		properties: {
			color: { type: "string", enum: ["red", "blue"], default: "blue" },
			count: { type: "integer", minimum: 1, maximum: 5, default: 2 },
			enabled: { type: "boolean", default: true },
			tags: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1, maxItems: 2, default: ["a"] },
		},
		required: ["color", "count", "enabled", "tags"],
	},
};

test("form elicitation collects, coerces, and locally reviews supported values", async () => {
	const fake = ui({ confirms: [true, true], selects: ["Use default", "No", "Done"], inputs: ["3"] });
	const result = await elicitForm("srv", form, fake.value as never);
	assert.equal(result.action, "accept");
	assert.deepEqual({ ...result.content }, { color: "blue", count: 3, enabled: false, tags: ["a"] });
	assert.match(fake.reviews.at(-1)!, /color: blue.*count: 3.*enabled: false.*tags: a/s);
});

test("form elicitation supports decline and cancellation without returning values", async () => {
	const declined = await elicitForm("srv", form, ui({ confirms: [false] }).value as never);
	assert.deepEqual(declined, { action: "decline" });
	const cancelled = await elicitForm("srv", {
		mode: "form", message: "one", requestedSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
	}, ui({ confirms: [true], inputs: [undefined] }).value as never);
	assert.deepEqual(cancelled, { action: "cancel" });
});

test("form elicitation rejects URL mode, unsafe or oversized schemas, and aborted work", async () => {
	const fake = ui().value as never;
	await assert.rejects(elicitForm("srv", { mode: "url", message: "open", url: "https://example.test" }, fake), /elicitation request was rejected/);
	await assert.rejects(elicitForm("srv", {
		mode: "form", message: "unsafe", requestedSchema: { type: "object", properties: { constructor: { type: "string" } } },
	}, fake), /elicitation request was rejected/);
	await assert.rejects(elicitForm("srv", {
		mode: "form", message: "large", requestedSchema: { type: "object", properties: { value: { type: "string", description: "x".repeat(40_000) } } },
	}, fake), /elicitation request was rejected/);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(elicitForm("srv", form, fake, controller.signal), /elicitation request was rejected/);
});
