import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFAULT_HOSTING_SETTINGS } from "../src/config.js";
import { DiagramHost } from "../src/server/host.js";
import { DiagramStore } from "../src/store.js";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-server-"));
  const store = new DiagramStore(directory);
  const document = await store.create("API flow", { nodes: [{ id: "api", label: "API" }], edges: [] });
  const host = new DiagramHost({ settings: { ...DEFAULT_HOSTING_SETTINGS, mode: "local", port: 0 }, store });
  await host.start();
  return { directory, store, document, host, url: host.urlFor(document) };
}

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
    assert.match(await asset.text(), /ClipboardItem/);
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

test("serves one-time publication challenges", async () => {
  const current = await fixture();
  try {
    const token = "B".repeat(32);
    const clear = current.host.setChallenge(token);
    const url = `${current.host.publicBaseUrl}/_challenge/${token}`;
    assert.equal(await (await fetch(url)).text(), token);
    clear();
    assert.equal((await fetch(url)).status, 404);
  } finally { await current.host.close(); await rm(current.directory, { recursive: true, force: true }); }
});
