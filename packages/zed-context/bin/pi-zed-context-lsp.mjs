import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const CAPTURE_VERSION = 1;
const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CONTEXT_BYTES = 50 * 1024;
const MAX_CONTEXT_LINES = 2_000;
const MAX_LSP_HEADER_BYTES = 16 * 1024;
const MAX_LSP_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_DOCUMENT_BYTES = 128 * 1024 * 1024;
const LEASE_REFRESH_MS = 5_000;
const PROCESS_PRODUCER_ID = randomUUID();

function stateDirectory(env = process.env) {
	const override = env.PI_ZED_CONTEXT_STATE_DIR?.trim();
	if (override) return resolve(override);
	return resolve(tmpdir(), `pi-zed-context-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function countSelectedLines(text) {
	if (!text) return 0;
	const newlineCount = text.match(/\n/g)?.length ?? 0;
	return Math.max(1, newlineCount + (text.endsWith("\n") ? 0 : 1));
}

function truncateUtf8(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, Math.max(0, end));
}

function boundSelection(text) {
	let bounded = text;
	let truncated = false;
	const lines = bounded.split("\n");
	if (lines.length > MAX_CONTEXT_LINES) {
		bounded = lines.slice(0, MAX_CONTEXT_LINES).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(bounded, "utf8") > MAX_CONTEXT_BYTES) {
		bounded = truncateUtf8(bounded, MAX_CONTEXT_BYTES);
		truncated = true;
	}
	return { text: bounded, truncated };
}

function ensurePrivateStateDirectory(directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(directory);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error(`Unsafe Zed context state directory: ${directory}`);
	}
	if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
		throw new Error(`Zed context state directory is owned by another user: ${directory}`);
	}
	chmodSync(directory, 0o700);
}

function producerLeasePath(producerId, env = process.env) {
	const key = createHash("sha256").update(producerId).digest("hex").slice(0, 32);
	return resolve(stateDirectory(env), `.lease-${key}.json`);
}

export function writeProducerLease(producerId = PROCESS_PRODUCER_ID, env = process.env) {
	const directory = stateDirectory(env);
	ensurePrivateStateDirectory(directory);
	const destination = producerLeasePath(producerId, env);
	const temporary = resolve(directory, `.lease.${process.pid}.${randomUUID()}.tmp`);
	const lease = { version: 1, producerId, producerPid: process.pid, updatedAt: Date.now() };
	writeFileSync(temporary, `${JSON.stringify(lease)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
	return lease;
}

function removeProducerLease(producerId = PROCESS_PRODUCER_ID, env = process.env) {
	rmSync(producerLeasePath(producerId, env), { force: true });
}

function canonicalPath(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isInsideOrEqual(parent, child) {
	const path = relative(canonicalPath(parent), canonicalPath(child));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function captureDestination(workspace, env = process.env) {
	const key = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 24);
	return resolve(stateDirectory(env), `${key}.json`);
}

function removeStaleCaptures(directory, now) {
	const staleBefore = now - MAX_CAPTURE_AGE_MS;
	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.endsWith(".json")) continue;
			const path = resolve(directory, entry);
			try {
				if (lstatSync(path).mtimeMs < staleBefore) rmSync(path, { force: true });
			} catch {
				// Another process may be replacing the snapshot concurrently.
			}
		}
	} catch {
		// Cleanup is best effort and must not fail a selection update.
	}
}

export function writeLspCapture(
	{ workspace, file, text, cursorRow, producerId = PROCESS_PRODUCER_ID },
	env = process.env,
) {
	const normalizedWorkspace = canonicalPath(workspace);
	const normalizedFile = canonicalPath(file);
	if (!isInsideOrEqual(normalizedWorkspace, normalizedFile)) {
		throw new Error("Selected file is outside the Zed worktree");
	}
	const capturedAt = Date.now();
	const bounded = boundSelection(text);
	writeProducerLease(producerId, env);
	const capture = {
		version: CAPTURE_VERSION,
		id: randomUUID(),
		workspace: normalizedWorkspace,
		file: normalizedFile,
		text: bounded.text,
		lineCount: countSelectedLines(text),
		cursorRow,
		capturedAt,
		source: "lsp",
		producerPid: process.pid,
		producerId,
		truncated: bounded.truncated || undefined,
	};
	const directory = stateDirectory(env);
	ensurePrivateStateDirectory(directory);
	const destination = captureDestination(normalizedWorkspace, env);
	const temporary = resolve(directory, `.${process.pid}.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(capture)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
	removeStaleCaptures(directory, capturedAt);
	return capture;
}

export function positionToOffset(text, position) {
	if (!Number.isInteger(position?.line) || position.line < 0) return undefined;
	if (!Number.isInteger(position?.character) || position.character < 0) return undefined;
	let line = 0;
	let lineStart = 0;

	while (line < position.line) {
		const newline = text.indexOf("\n", lineStart);
		if (newline < 0) return undefined;
		lineStart = newline + 1;
		line += 1;
	}

	let lineEnd = text.indexOf("\n", lineStart);
	if (lineEnd < 0) lineEnd = text.length;
	if (lineEnd > lineStart && text.charCodeAt(lineEnd - 1) === 13) lineEnd -= 1;
	if (position.character > lineEnd - lineStart) return undefined;
	const offset = lineStart + position.character;
	if (
		offset > lineStart &&
		offset < lineEnd &&
		text.charCodeAt(offset - 1) >= 0xd800 && text.charCodeAt(offset - 1) <= 0xdbff &&
		text.charCodeAt(offset) >= 0xdc00 && text.charCodeAt(offset) <= 0xdfff
	) return undefined;
	return offset;
}

export function applyContentChanges(text, changes) {
	let current = text;
	for (const change of changes ?? []) {
		if (!change || typeof change.text !== "string") continue;
		if (!change.range) {
			current = change.text;
			continue;
		}
		const start = positionToOffset(current, change.range.start);
		const end = positionToOffset(current, change.range.end);
		if (start === undefined || end === undefined || end < start) {
			throw new Error("Invalid UTF-16 range in textDocument/didChange");
		}
		current = `${current.slice(0, start)}${change.text}${current.slice(end)}`;
	}
	return current;
}

export function textForRange(text, range) {
	const start = positionToOffset(text, range?.start);
	const end = positionToOffset(text, range?.end);
	if (start === undefined || end === undefined || end < start) return undefined;
	if (end === start) return "";
	return text.slice(start, end);
}

function pathFromDocumentUri(uri) {
	if (typeof uri !== "string") return undefined;
	try {
		const url = new URL(uri);
		if (url.protocol !== "file:") return undefined;
		return fileURLToPath(url);
	} catch {
		return undefined;
	}
}

export class PiSelectionLspServer {
	constructor({ workspace, env = process.env, log = (message) => process.stderr.write(`${message}\n`) }) {
		this.workspace = canonicalPath(workspace || process.cwd());
		this.env = env;
		this.log = log;
		this.documents = new Map();
		this.totalDocumentBytes = 0;
		this.lastSelectionFile = undefined;
		this.lastSelectionKey = undefined;
		this.selectionCleared = false;
		this.shutdownRequested = false;
		this.producerId = PROCESS_PRODUCER_ID;
		this.closed = false;
		writeProducerLease(this.producerId, this.env);
	}

	clearSelection(file = this.lastSelectionFile) {
		if (!file || this.selectionCleared) return;
		writeLspCapture({ workspace: this.workspace, file, text: "", producerId: this.producerId }, this.env);
		this.lastSelectionFile = undefined;
		this.lastSelectionKey = undefined;
		this.selectionCleared = true;
	}

	refreshLease() {
		if (!this.closed) writeProducerLease(this.producerId, this.env);
	}

	shutdown() {
		if (this.closed) return;
		this.closed = true;
		this.lastSelectionFile = undefined;
		this.lastSelectionKey = undefined;
		this.selectionCleared = true;
		removeProducerLease(this.producerId, this.env);
	}

	handle(message) {
		const method = message?.method;
		const params = message?.params ?? {};

		if (method === "initialize") {
			if (!this.workspace && typeof params.rootUri === "string") {
				const root = pathFromDocumentUri(params.rootUri);
				if (root) this.workspace = root;
			}
			return {
				result: {
					capabilities: {
						positionEncoding: "utf-16",
						textDocumentSync: { openClose: true, change: 2 },
						codeActionProvider: true,
					},
					serverInfo: { name: "pi-selection-bridge", version: "0.2.0" },
				},
			};
		}

		if (method === "textDocument/didOpen") {
			const document = params.textDocument;
			const file = pathFromDocumentUri(document?.uri);
			if (file && isInsideOrEqual(this.workspace, file) && typeof document.text === "string") {
				const bytes = Buffer.byteLength(document.text, "utf8");
				const previous = this.documents.get(document.uri);
				const nextTotal = this.totalDocumentBytes - (previous?.bytes ?? 0) + bytes;
				if (bytes <= MAX_DOCUMENT_BYTES && nextTotal <= MAX_TOTAL_DOCUMENT_BYTES) {
					this.documents.set(document.uri, { text: document.text, version: document.version, bytes });
					this.totalDocumentBytes = nextTotal;
				} else {
					this.log(`pi-selection-bridge: synchronized buffer exceeds memory budget: ${document.uri}`);
				}
			}
			return {};
		}

		if (method === "textDocument/didChange") {
			const document = params.textDocument;
			const current = typeof document?.uri === "string" ? this.documents.get(document.uri) : undefined;
			if (current) {
				if (Number.isInteger(document.version) && Number.isInteger(current.version) && document.version <= current.version) {
					this.log(`pi-selection-bridge: ignored stale document version for ${document.uri}`);
					return {};
				}
				const text = applyContentChanges(current.text, params.contentChanges);
				const bytes = Buffer.byteLength(text, "utf8");
				const nextTotal = this.totalDocumentBytes - current.bytes + bytes;
				if (bytes > MAX_DOCUMENT_BYTES || nextTotal > MAX_TOTAL_DOCUMENT_BYTES) {
					this.documents.delete(document.uri);
					this.totalDocumentBytes -= current.bytes;
					this.log(`pi-selection-bridge: dropped buffer after it exceeded memory budget: ${document.uri}`);
					return {};
				}
				current.text = text;
				current.version = document.version;
				current.bytes = bytes;
				this.totalDocumentBytes = nextTotal;
			}
			return {};
		}

		if (method === "textDocument/didClose") {
			const uri = params.textDocument?.uri;
			if (typeof uri === "string") {
				const document = this.documents.get(uri);
				if (document) this.totalDocumentBytes -= document.bytes;
				this.documents.delete(uri);
				const file = pathFromDocumentUri(uri);
				if (file && file === this.lastSelectionFile) this.clearSelection(file);
			}
			return {};
		}

		if (method === "textDocument/codeAction") {
			const uri = params.textDocument?.uri;
			const file = pathFromDocumentUri(uri);
			if (!file || !isInsideOrEqual(this.workspace, file)) return { result: [] };

			const document = this.documents.get(uri);
			if (!document) {
				this.log(`pi-selection-bridge: no synchronized buffer for ${uri}`);
				return { result: [] };
			}

			const range = params.range;
			const text = textForRange(document.text, range);
			if (text === undefined) {
				this.log(`pi-selection-bridge: ignored invalid selection range for ${uri}`);
				return { result: [] };
			}
			if (text.length === 0) {
				this.clearSelection(file);
				return { result: [] };
			}
			const selectionHash = createHash("sha256").update(text).digest("hex");
			const selectionKey = `${file}\0${range.start.line}:${range.start.character}-${range.end.line}:${range.end.character}\0${selectionHash}`;
			if (selectionKey === this.lastSelectionKey) return { result: [] };
			writeLspCapture({
				workspace: this.workspace,
				file,
				text,
				cursorRow: range.start.line + 1,
				producerId: this.producerId,
			}, this.env);
			this.lastSelectionFile = file;
			this.lastSelectionKey = selectionKey;
			this.selectionCleared = false;
			return { result: [] };
		}

		if (method === "shutdown") {
			this.shutdownRequested = true;
			this.shutdown();
			return { result: null };
		}

		if (method === "exit") {
			const exitCode = this.shutdownRequested ? 0 : 1;
			this.shutdown();
			return { exit: true, exitCode };
		}

		if (message?.id !== undefined) {
			if (typeof method !== "string") return { error: { code: -32600, message: "Invalid Request" } };
			return { error: { code: -32601, message: `Method not found: ${method}` } };
		}
		return {};
	}
}

function writeResponse(output, id, result, error) {
	const message = error
		? { jsonrpc: "2.0", id, error }
		: { jsonrpc: "2.0", id, result: result ?? null };
	const body = JSON.stringify(message);
	output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

export function runLspServer({ workspace, input = process.stdin, output = process.stdout, error = process.stderr, env = process.env }) {
	const server = new PiSelectionLspServer({
		workspace: workspace || process.cwd(),
		env,
		log: (message) => error.write(`${message}\n`),
	});
	const leaseTimer = setInterval(() => server.refreshLease(), LEASE_REFRESH_MS);
	leaseTimer.unref();
	let buffered = Buffer.alloc(0);

	function processMessages() {
		while (true) {
			const headerEnd = buffered.indexOf("\r\n\r\n");
			if (headerEnd < 0) {
				if (buffered.length > MAX_LSP_HEADER_BYTES) {
					error.write("pi-selection-bridge: LSP header exceeded 16 KB\n");
					input.destroy();
				}
				return;
			}
			if (headerEnd > MAX_LSP_HEADER_BYTES) {
				error.write("pi-selection-bridge: LSP header exceeded 16 KB\n");
				input.destroy();
				return;
			}
			const header = buffered.subarray(0, headerEnd).toString("ascii");
			const match = header.match(/(?:^|\r\n)Content-Length:\s*(\d+)/i);
			if (!match) {
				error.write("pi-selection-bridge: invalid LSP header\n");
				buffered = buffered.subarray(headerEnd + 4);
				continue;
			}
			const length = Number(match[1]);
			if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LSP_MESSAGE_BYTES) {
				error.write(`pi-selection-bridge: invalid Content-Length ${match[1]}\n`);
				input.destroy();
				return;
			}
			const bodyStart = headerEnd + 4;
			if (buffered.length < bodyStart + length) return;
			const body = buffered.subarray(bodyStart, bodyStart + length).toString("utf8");
			buffered = buffered.subarray(bodyStart + length);

			let message;
			try {
				message = JSON.parse(body);
			} catch (caught) {
				const detail = caught instanceof Error ? caught.message : String(caught);
				error.write(`pi-selection-bridge: ${detail}\n`);
				writeResponse(output, null, undefined, { code: -32700, message: "Parse error" });
				continue;
			}

			try {
				const outcome = server.handle(message);
				if (message.id !== undefined) writeResponse(output, message.id, outcome.result, outcome.error);
				if (outcome.exit) {
					input.pause();
					setImmediate(() => process.exit(outcome.exitCode));
					return;
				}
			} catch (caught) {
				const detail = caught instanceof Error ? caught.message : String(caught);
				error.write(`pi-selection-bridge: ${detail}\n`);
				if (message?.id !== undefined) {
					writeResponse(output, message.id, undefined, { code: -32603, message: detail });
				}
			}
		}
	}

	input.on("data", (chunk) => {
		buffered = Buffer.concat([buffered, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		processMessages();
	});
	const shutdown = () => {
		clearInterval(leaseTimer);
		server.shutdown();
	};
	input.on("end", shutdown);
	input.on("error", shutdown);
	process.once("SIGTERM", () => {
		shutdown();
		process.exit(0);
	});
	process.once("SIGINT", () => {
		shutdown();
		process.exit(0);
	});
	input.resume();
	return server;
}
