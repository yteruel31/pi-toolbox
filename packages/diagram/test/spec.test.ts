import assert from "node:assert/strict";
import test from "node:test";

import { applyPatch, normalizeSpec } from "../src/spec.js";

test("normalizes defaults and stable edge ids", () => {
  const spec = normalizeSpec({
    nodes: [{ id: "api", label: "API" }, { id: "db", label: "Database" }],
    edges: [{ from: "api", to: "db" }],
  });
  assert.equal(spec.direction, "TB");
  assert.equal(spec.theme, "light");
  assert.equal(spec.edges[0]?.id, "edge:api:db:0");
  assert.deepEqual(spec.groups, []);
});

test("applies focused patches idempotently", () => {
  const original = normalizeSpec({
    nodes: [{ id: "api", label: "API" }, { id: "db", label: "Database" }],
    edges: [{ id: "writes", from: "api", to: "db" }],
  });
  const patch = { set_nodes: [{ id: "api", label: "Public API", shape: "rounded" }], set_theme: "dark" };
  const once = applyPatch(original, patch).spec;
  const twice = applyPatch(once, patch).spec;
  assert.deepEqual(twice, once);
  assert.equal(once.nodes.find(({ id }) => id === "api")?.label, "Public API");
  assert.equal(once.theme, "dark");
});

test("removing a node also removes its connected edges", () => {
  const original = normalizeSpec({
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    edges: [{ id: "a-to-b", from: "a", to: "b" }],
  });
  const result = applyPatch(original, { remove_node_ids: ["b"] }).spec;
  assert.deepEqual(result.nodes.map(({ id }) => id), ["a"]);
  assert.deepEqual(result.edges, []);
});

test("rejects dangling references, duplicate ids, unsafe colors, and unknown keys", () => {
  assert.throws(() => normalizeSpec({ nodes: [{ id: "a", label: "A" }], edges: [{ from: "a", to: "missing" }] }), /unknown node/);
  assert.throws(() => normalizeSpec({ nodes: [{ id: "a", label: "A" }, { id: "a", label: "Again" }], edges: [] }), /Duplicate node/);
  assert.throws(() => normalizeSpec({ nodes: [{ id: "a", label: "A", fill: "url(evil)" }], edges: [] }), /hex color/);
  assert.throws(() => normalizeSpec({ nodes: [], edges: [], rawSvg: "<script/>" }), /not supported/);
});
