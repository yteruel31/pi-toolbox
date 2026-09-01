import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applyPatch } from "../src/spec.js";
import { DiagramStore } from "../src/store.js";

const sample = { nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] };

test("persists documents, revisions, and capability tokens across store restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-store-"));
  try {
    const first = new DiagramStore(directory);
    const created = await first.create("Flow", sample);
    assert.match(created.id, /^diag_[0-9a-f]{12}$/);
    assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
    const updated = await first.update(created.id, { title: "Updated flow", spec: created.spec });
    assert.equal(updated.revision, 2);

    const second = new DiagramStore(directory);
    assert.deepEqual(await second.get(created.id), updated);
    assert.deepEqual(await second.getByToken(created.token), updated);
    assert.equal((await second.list()).length, 1);
    const file = path.join(directory, `${created.id}.json`);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(file, "utf8")).title, "Updated flow");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("serializes concurrent updates and invalidates deleted tokens", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-store-queue-"));
  try {
    const store = new DiagramStore(directory);
    const created = await store.create("Flow", sample);
    await Promise.all(Array.from({ length: 5 }, (_, index) => store.update(created.id, { title: `Flow ${index}`, spec: created.spec })));
    assert.equal((await store.get(created.id))?.revision, 6);
    assert.equal(await store.delete(created.id), true);
    assert.equal(await store.getByToken(created.token), undefined);
    assert.equal(await store.delete(created.id), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("serializes read-modify-write patches without losing concurrent changes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-store-patches-"));
  try {
    const store = new DiagramStore(directory);
    const created = await store.create("Flow", sample);
    await Promise.all([
      store.updateWith(created.id, (current) => ({ spec: applyPatch(current.spec, { set_nodes: [{ id: "a", label: "Updated A" }] }).spec })),
      store.updateWith(created.id, (current) => ({ spec: applyPatch(current.spec, { set_nodes: [{ id: "b", label: "Updated B" }] }).spec })),
    ]);
    const updated = await store.get(created.id);
    assert.equal(updated?.spec.nodes.find(({ id }) => id === "a")?.label, "Updated A");
    assert.equal(updated?.spec.nodes.find(({ id }) => id === "b")?.label, "Updated B");
    assert.equal(updated?.revision, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("serializes mutations from independent Pi processes through the shared store lock", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-store-processes-"));
  try {
    const first = new DiagramStore(directory);
    const second = new DiagramStore(directory);
    const created = await first.create("Flow", sample);
    await Promise.all([
      first.updateWith(created.id, (current) => ({ spec: applyPatch(current.spec, { set_nodes: [{ id: "a", label: "Updated A" }] }).spec })),
      second.updateWith(created.id, (current) => ({ spec: applyPatch(current.spec, { set_nodes: [{ id: "b", label: "Updated B" }] }).spec })),
    ]);
    const updated = await first.get(created.id);
    assert.equal(updated?.spec.nodes.find(({ id }) => id === "a")?.label, "Updated A");
    assert.equal(updated?.spec.nodes.find(({ id }) => id === "b")?.label, "Updated B");
    assert.equal(updated?.revision, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("refuses a symlinked storage directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-store-symlink-"));
  const target = path.join(root, "target");
  const linked = path.join(root, "documents");
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(target));
    await symlink(target, linked, "dir");
    const store = new DiagramStore(linked);
    await assert.rejects(() => store.list(), /real directory/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ignores corrupt files without hiding valid documents", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-store-corrupt-"));
  try {
    const first = new DiagramStore(directory);
    const created = await first.create("Flow", sample);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(directory, "broken.json"), "{"));
    const second = new DiagramStore(directory);
    assert.equal((await second.list()).length, 1);
    assert.equal((await second.get(created.id))?.title, "Flow");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
