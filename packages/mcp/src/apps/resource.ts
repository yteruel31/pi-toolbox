import { getToolUiResourceUri, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { Tool, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { MAX_RESOURCE_BYTES, normalizeMeta } from "./security.js";

export interface AppResource { uri: string; html: string; meta: ReturnType<typeof normalizeMeta> }
export function appResourceUri(tool: Tool): string | undefined {
	try { const uri = getToolUiResourceUri(tool); return uri?.startsWith("ui://") ? uri : undefined; } catch { return undefined; }
}
function strictBase64(value: string): Buffer {
	const maxEncodedBytes = Math.ceil(MAX_RESOURCE_BYTES / 3) * 4;
	if (value.length > maxEncodedBytes) throw new Error("App resource exceeds limit");
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("Invalid App resource base64");
	return Buffer.from(value, "base64");
}
export function selectAppResource(result: ReadResourceResult, uri: string): AppResource {
	const item = result.contents.find(content => content.uri === uri);
	if (!item) throw new Error("App resource URI was not returned");
	const mime = item.mimeType?.toLowerCase().split(";").map(value => value.trim()) ?? [];
	const mediaType = mime[0];
	const parameters = mime.slice(1);
	const official = item.mimeType?.toLowerCase() === RESOURCE_MIME_TYPE;
	if (!official && (mediaType !== "text/html" || parameters.some(parameter => !/^(?:charset=utf-8|profile=mcp-app)$/.test(parameter)))) throw new Error("Unsupported App resource MIME type");
	if ("text" in item) {
		const bytes = Buffer.byteLength(item.text, "utf8");
		if (!bytes) throw new Error("Empty App resource");
		if (bytes > MAX_RESOURCE_BYTES) throw new Error("App resource exceeds limit");
		if (Buffer.from(item.text, "utf8").toString("utf8") !== item.text) throw new Error("App resource is not valid UTF-8");
		return { uri, html: item.text, meta: normalizeMeta(item._meta) };
	}
	if (!("blob" in item)) throw new Error("Empty App resource");
	const bytes = strictBase64(item.blob);
	if (!bytes.length) throw new Error("Empty App resource");
	if (bytes.length > MAX_RESOURCE_BYTES) throw new Error("App resource exceeds limit");
	const html = bytes.toString("utf8");
	if (!Buffer.from(html, "utf8").equals(bytes)) throw new Error("App resource is not valid UTF-8");
	return { uri, html, meta: normalizeMeta(item._meta) };
}
