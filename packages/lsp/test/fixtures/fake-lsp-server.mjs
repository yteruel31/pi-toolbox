const documents = new Map();
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
}

function positionAt(text, offset) {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length - 1, character: lines.at(-1).length };
}

function publish(uri, text) {
  const index = text.indexOf("BROKEN");
  const diagnostics = index === -1 ? [] : [{
    range: { start: positionAt(text, index), end: positionAt(text, index + 6) },
    severity: 1,
    code: "fake-error",
    source: "fake",
    message: "BROKEN is not valid",
  }];
  setTimeout(() => send({ method: "textDocument/publishDiagnostics", params: { uri, diagnostics } }), Number(process.env.FAKE_LSP_DELAY_MS ?? 0));
}

function rangesFor(text, needle, newText) {
  const edits = [];
  let offset = 0;
  while ((offset = text.indexOf(needle, offset)) !== -1) {
    edits.push({ range: { start: positionAt(text, offset), end: positionAt(text, offset + needle.length) }, newText });
    offset += needle.length;
  }
  return edits;
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    setTimeout(
      () => send({ id, result: { capabilities: { textDocumentSync: 1, hoverProvider: true, definitionProvider: true, referencesProvider: true, documentSymbolProvider: true, renameProvider: { prepareProvider: true } } } }),
      Number(process.env.FAKE_LSP_INIT_DELAY_MS ?? 0),
    );
    return;
  }
  if (method === "shutdown") {
    send({ id, result: null });
    return;
  }
  if (method === "exit") {
    setImmediate(() => process.exit(0));
    return;
  }
  if (method === "textDocument/didOpen") {
    const { uri, text } = params.textDocument;
    documents.set(uri, text);
    publish(uri, text);
    return;
  }
  if (method === "textDocument/didChange") {
    const uri = params.textDocument.uri;
    const text = params.contentChanges.at(-1).text;
    documents.set(uri, text);
    publish(uri, text);
    return;
  }
  if (method === "textDocument/hover") {
    send({ id, result: { contents: { kind: "markdown", value: "```ts\nconst alpha: number\n```" } } });
    return;
  }
  if (method === "textDocument/definition") {
    send({ id, result: [{ uri: params.textDocument.uri, range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }] });
    return;
  }
  if (method === "textDocument/references") {
    send({ id, result: [{ uri: params.textDocument.uri, range: { start: params.position, end: { line: params.position.line, character: params.position.character + 5 } } }] });
    return;
  }
  if (method === "textDocument/documentSymbol") {
    send({ id, result: [{ name: "alpha", kind: 13, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } } }] });
    return;
  }
  if (method === "textDocument/prepareRename") {
    send({ id, result: { start: params.position, end: { line: params.position.line, character: params.position.character + 5 } } });
    return;
  }
  if (method === "textDocument/rename") {
    const uri = params.textDocument.uri;
    const edits = rangesFor(documents.get(uri) ?? "", "alpha", params.newName);
    const configuredVersion = process.env.FAKE_LSP_RENAME_VERSION;
    const result = configuredVersion === undefined
      ? { changes: { [uri]: edits } }
      : { documentChanges: [{ textDocument: { uri, version: Number(configuredVersion) }, edits }] };
    send({ id, result });
    return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) break;
    const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
    buffer = buffer.subarray(start + length);
    handle(message);
  }
});
