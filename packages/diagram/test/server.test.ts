import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import test from "node:test";

import { DEFAULT_HOSTING_SETTINGS } from "../src/config.js";
import { DiagramHost, supportsReusePort } from "../src/server/host.js";
import { DiagramStore } from "../src/store.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-server-"));
  const store = new DiagramStore(directory);
  const document = await store.create("API flow", { nodes: [{ id: "api", label: "API" }], edges: [] });
  const host = new DiagramHost({ settings: { ...DEFAULT_HOSTING_SETTINGS, mode: "local", port: 0 }, store });
  await host.start();
  return { directory, store, document, host, url: host.urlFor(document) };
}

test("enables fixed-port sharing only on supported operating systems", () => {
  assert.equal(supportsReusePort("linux"), true);
  assert.equal(supportsReusePort("darwin"), false);
  assert.equal(supportsReusePort("win32"), false);
});

test("serves a capability-scoped viewer with strict headers and assets", async () => {
  const current = await fixture();
  try {
    const page = await fetch(current.url);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
    assert.doesNotMatch(page.headers.get("content-security-policy") ?? "", /unsafe-inline/);
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(await page.text(), /Copy image/);

    const asset = await fetch(new URL("../../assets/viewer.js", current.url));
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /text\/javascript/);
    const client = await asset.text();
    assert.match(client, /ClipboardItem/);
    assert.match(client, /Diagram deleted/);
  } finally { await current.host.close(); await rm(current.directory, { recursive: true, force: true }); }
});

test("supports hosting at the external root path without protocol-relative assets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-server-root-"));
  const store = new DiagramStore(directory);
  const document = await store.create("Root", { nodes: [{ id: "root", label: "Root" }], edges: [] });
  const host = new DiagramHost({ settings: { ...DEFAULT_HOSTING_SETTINGS, mode: "local", basePath: "/", port: 0 }, store });
  await host.start();
  try {
    const url = host.urlFor(document);
    assert.doesNotMatch(url, /\/\/d\//);
    const html = await (await fetch(url)).text();
    assert.match(html, /src="\/assets\/viewer.js"/);
    assert.doesNotMatch(html, /src="\/\/assets/);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("serves SVG and PNG downloads while unknown capabilities stay indistinguishable", async () => {
  const current = await fixture();
  try {
    const svg = await fetch(new URL("./image.svg", current.url));
    assert.equal(svg.status, 200);
    assert.match(svg.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await svg.text(), /<svg/);
    const png = await fetch(new URL("./download.png", current.url));
    assert.equal(png.status, 200);
    assert.match(png.headers.get("content-disposition") ?? "", /attachment; filename="API-flow.png"/);
    const unknown = current.url.replace(current.document.token, "A".repeat(43));
    assert.equal((await fetch(unknown)).status, 404);
    assert.equal((await fetch(`${current.host.publicBaseUrl}/_challenge/${"A".repeat(32)}`)).status, 404);
  } finally { await current.host.close(); await rm(current.directory, { recursive: true, force: true }); }
});

test("requires a Tailscale identity header when configured", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-server-identity-"));
  const store = new DiagramStore(directory);
  const document = await store.create("Private", { nodes: [{ id: "private", label: "Private" }], edges: [] });
  const host = new DiagramHost({ settings: { ...DEFAULT_HOSTING_SETTINGS, mode: "tailscale", port: 0, requireTailscaleIdentity: true }, store });
  await host.start();
  try {
    const url = host.urlFor(document);
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { headers: { "tailscale-user-login": "reviewer@example.com" } })).status, 200);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test("publishes revision updates over SSE", async () => {
  const current = await fixture();
  try {
    const response = await fetch(new URL("./events", current.url));
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /event: updated\ndata: 1/);
    const updated = await current.store.update(current.document.id, { title: current.document.title, spec: current.document.spec });
    current.host.notifyUpdated(updated);
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /event: updated\ndata: 2/);
    await reader.cancel();
  } finally { await current.host.close(); await rm(current.directory, { recursive: true, force: true }); }
});

test("bounds live update streams per document", async () => {
  const current = await fixture();
  const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
  try {
    for (let index = 0; index < 8; index += 1) {
      const response = await fetch(new URL("./events", current.url));
      assert.equal(response.status, 200);
      readers.push(response.body!.getReader());
    }
    const excess = await fetch(new URL("./events", current.url));
    assert.equal(excess.status, 503);
    assert.equal(excess.headers.get("retry-after"), "15");
  } finally {
    await Promise.all(readers.map((reader) => reader.cancel()));
    await current.host.close();
    await rm(current.directory, { recursive: true, force: true });
  }
});

test("shares one fixed port and persisted updates across concurrent Pi sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-server-shared-"));
  const port = await freePort();
  const settings = { ...DEFAULT_HOSTING_SETTINGS, mode: "local" as const, port };
  const firstStore = new DiagramStore(directory);
  const secondStore = new DiagramStore(directory);
  const firstHost = new DiagramHost({ settings, store: firstStore });
  const secondHost = new DiagramHost({ settings, store: secondStore });
  await firstHost.start();
  await secondHost.start();
  try {
    const challenge = "C".repeat(32);
    const clearChallenge = await firstHost.setChallenge(challenge);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      assert.equal(await (await fetch(`${firstHost.publicBaseUrl}/_challenge/${challenge}`)).text(), challenge);
    }
    await clearChallenge();

    const document = await firstStore.create("Shared", { nodes: [{ id: "node", label: "First" }], edges: [] });
    const url = firstHost.urlFor(document);
    for (let attempt = 0; attempt < 6; attempt += 1) assert.equal((await fetch(url)).status, 200);

    const events = await fetch(new URL("./events", url));
    const reader = events.body!.getReader();
    const initial = new TextDecoder().decode((await reader.read()).value);
    assert.match(initial, /data: 1/);
    const updated = await secondStore.updateWith(document.id, (current) => ({
      spec: { ...current.spec, nodes: [{ id: "node", label: "Updated elsewhere" }] },
    }));
    assert.equal(updated.revision, 2);
    const notification = await readWithTimeout(reader, 3_000);
    assert.match(new TextDecoder().decode(notification.value), /event: updated\ndata: 2/);
    await reader.cancel();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      const svg = await (await fetch(new URL("./image.svg", url))).text();
      assert.match(svg, /Updated elsewhere/);
    }
    await firstHost.close();
    assert.equal(await fetchStatusEventually(url), 200);
  } finally {
    await firstHost.close();
    await secondHost.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("serves one-time publication challenges", async () => {
  const current = await fixture();
  try {
    const token = "B".repeat(32);
    const clear = await current.host.setChallenge(token);
    const url = `${current.host.publicBaseUrl}/_challenge/${token}`;
    assert.equal(await (await fetch(url)).text(), token);
    await clear();
    assert.equal((await fetch(url)).status, 404);
  } finally { await current.host.close(); await rm(current.directory, { recursive: true, force: true }); }
});

async function readWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>, timeoutMs: number) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("cross-session SSE timeout")), timeoutMs); }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchStatusEventually(url: string): Promise<number> {
  let error: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { return (await fetch(url)).status; }
    catch (candidate) { error = candidate; await new Promise((resolve) => setTimeout(resolve, 25)); }
  }
  throw error;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
