import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const MAX_SCHEMA_BYTES = 32_768;
const MAX_FIELDS = 24;
const MAX_TEXT = 4_096;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
type UI = Pick<ExtensionContext["ui"], "select" | "confirm" | "input">;
type Field = Record<string, unknown>;

function fail(): never { throw new Error("MCP elicitation request was rejected"); }
const unsafeDisplay = (value: string): boolean => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const display = (value: unknown): string => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, MAX_TEXT);
function choices(field: Field): Array<{ label: string; value: string }> | undefined {
	if (Array.isArray(field.enum) && field.enum.every((x) => typeof x === "string")) {
		const names = Array.isArray(field.enumNames) ? field.enumNames : field.enum;
		return field.enum.map((value, i) => ({ value, label: typeof names[i] === "string" ? names[i] as string : value }));
	}
	if (Array.isArray(field.oneOf) && field.oneOf.every((x) => x && typeof x === "object" && typeof (x as Field).const === "string" && typeof (x as Field).title === "string"))
		return field.oneOf.map((x) => ({ value: (x as Field).const as string, label: (x as Field).title as string }));
	return undefined;
}
function checkedText(value: string, field: Field): string {
	const min = typeof field.minLength === "number" ? field.minLength : 0;
	const max = typeof field.maxLength === "number" ? Math.min(field.maxLength, MAX_TEXT) : MAX_TEXT;
	if (value.length < min || value.length > max) fail();
	return value;
}
function validateSchema(schema: unknown): { properties: Record<string, Field>; required: Set<string> } {
	let bytes = Infinity; try { bytes = Buffer.byteLength(JSON.stringify(schema)); } catch { /* rejected below */ }
	if (!schema || typeof schema !== "object" || bytes > MAX_SCHEMA_BYTES) fail();
	const object = schema as Field;
	if (object.type !== "object" || !object.properties || typeof object.properties !== "object" || Array.isArray(object.properties)) fail();
	const properties = object.properties as Record<string, Field>;
	if (Object.keys(properties).length > MAX_FIELDS || Object.keys(properties).some((k) => !k || k.length > 128 || unsafeDisplay(k) || UNSAFE_KEYS.has(k) || !properties[k] || typeof properties[k] !== "object")) fail();
	const required = new Set(Array.isArray(object.required) && object.required.every((x) => typeof x === "string") ? object.required as string[] : []);
	if ([...required].some((k) => !properties[k])) fail();
	for (const field of Object.values(properties)) {
		if (!["string", "number", "integer", "boolean", "array"].includes(field.type as string)) fail();
		if ([field.title, field.description].some((value) => value !== undefined && (typeof value !== "string" || value.length > MAX_TEXT || unsafeDisplay(value)))) fail();
		const options = choices(field);
		if (options && (options.length < 1 || options.length > 100 || options.some((x) => x.value.length > 512 || x.label.length > 512 || unsafeDisplay(x.label)) || new Set(options.map((x) => x.label)).size !== options.length)) fail();
		if (field.type === "array") {
			if (!field.items || typeof field.items !== "object" || (field.items as Field).type !== "string") fail();
			const itemOptions = choices(field.items as Field);
			if (!itemOptions || itemOptions.length > 100 || itemOptions.some((item) => unsafeDisplay(item.label) || item.label.length > 512 || item.value.length > 512) || new Set(itemOptions.map((x) => x.label)).size !== itemOptions.length) fail();
		}
	}
	return { properties, required };
}

export async function elicitForm(server: string, params: Record<string, unknown>, ui: UI, signal?: AbortSignal): Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }> {
	if (signal?.aborted || params.mode === "url" || typeof params.message !== "string" || params.message.length > MAX_TEXT || unsafeDisplay(params.message)) fail();
	const { properties, required } = validateSchema(params.requestedSchema);
	if (!await ui.confirm(`MCP form — ${server}`, `${params.message}\n\nContinue?`, { signal })) return { action: "decline" };
	const result: Record<string, unknown> = Object.create(null);
	for (const [name, field] of Object.entries(properties)) {
		if (signal?.aborted) return { action: "cancel" };
		const label = `${typeof field.title === "string" ? field.title : name}${required.has(name) ? " (required)" : " (optional)"}`;
		if (!required.has(name) && !await ui.confirm(label, "Provide this optional value?", { signal })) continue;
		if (field.type === "boolean") {
			const actions = ["Yes", "No", ...(typeof field.default === "boolean" ? ["Use default"] : [])];
			const answer = await ui.select(label, actions, { signal });
			if (answer === undefined) return { action: "cancel" };
			result[name] = answer === "Use default" ? field.default : answer === "Yes";
		} else if (field.type === "array") {
			const itemOptions = choices(field.items as Field); if (!itemOptions) fail();
			const defaults = Array.isArray(field.default) && field.default.every((value) => typeof value === "string" && itemOptions.some((item) => item.value === value)) ? field.default as string[] : [];
			const selected: string[] = [...defaults];
			const min = typeof field.minItems === "number" ? field.minItems : 0, max = typeof field.maxItems === "number" ? Math.min(field.maxItems, itemOptions.length) : itemOptions.length;
			if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min || selected.length > max) fail();
			while (selected.length < max) {
				const remaining = itemOptions.filter((x) => !selected.includes(x.value));
				const actions = [...(selected.length >= min ? ["Done"] : []), ...remaining.map((x) => x.label)];
				const answer = await ui.select(label, actions, { signal });
				if (answer === undefined) return { action: "cancel" }; if (answer === "Done") break;
				const choice = remaining.find((x) => x.label === answer); if (!choice) fail(); selected.push(choice.value);
			}
			if (selected.length < min) fail(); result[name] = selected;
		} else {
			const options = choices(field); let raw: string | undefined;
			if (options) {
				const actions = [...options.map((x) => x.label), ...(typeof field.default === "string" && options.some((item) => item.value === field.default) ? ["Use default"] : [])];
				const answer = await ui.select(label, actions, { signal });
				if (answer === "Use default") raw = field.default as string;
				else if (answer !== undefined) raw = options.find((x) => x.label === answer)?.value;
			} else raw = await ui.input(label, typeof field.default === "string" || typeof field.default === "number" ? String(field.default) : "", { signal });
			if (raw === undefined) return { action: "cancel" };
			if (field.type === "string") result[name] = checkedText(raw, field);
			else { const value = Number(raw); if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value)) || (typeof field.minimum === "number" && value < field.minimum) || (typeof field.maximum === "number" && value > field.maximum)) fail(); result[name] = value; }
		}
	}
	const review = Object.entries(result).map(([name, value]) => `${display(name)}: ${display(Array.isArray(value) ? value.join(", ") : value)}`).join("\n");
	// Values are shown only in this local review prompt and are never logged or added to model/tool details.
	return await ui.confirm(`Review MCP form — ${server}`, `${review || "No values"}\n\nSubmit ${Object.keys(result).length} field(s)?`, { signal }) ? { action: "accept", content: result } : { action: "decline" };
}
