import assert from "node:assert/strict";
import test from "node:test";

import { layoutDiagram, wrapLabel } from "../src/layout.js";
import { renderPng } from "../src/render/png.js";
import { renderSvg } from "../src/render/svg.js";
import { normalizeSpec } from "../src/spec.js";

const spec = normalizeSpec({
  direction: "LR",
  theme: "light",
  groups: [{ id: "backend", label: "Backend" }],
  nodes: [
    { id: "web", label: "Web <script>alert(1)</script>" },
    { id: "api", label: "API & workers", group: "backend", shape: "rounded" },
    { id: "db", label: "Database", group: "backend", shape: "cylinder" },
  ],
  edges: [{ id: "request", from: "web", to: "api", label: "HTTPS" }, { id: "query", from: "api", to: "db", style: "dashed" }],
});

test("lays out the same graph deterministically", () => {
  assert.deepEqual(layoutDiagram(spec), layoutDiagram(spec));
  assert.ok(layoutDiagram(spec).nodes.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
});

test("serializes one deterministic, escaped SVG without active content", () => {
  const first = renderSvg("Architecture & flow", spec);
  const second = renderSvg("Architecture & flow", spec);
  assert.equal(first.svg, second.svg);
  assert.match(first.svg, />Web<\/text>/);
  assert.match(first.svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(first.svg, /<script>/);
  assert.doesNotMatch(first.svg, /foreignObject|(?:href|src)=["']https?:\/\//);
  assert.ok(first.width > 0 && first.height > 0);
});

test("renders PNG from the exact serialized SVG", () => {
  const png = renderPng(renderSvg("Architecture", spec), 2);
  assert.equal(png.png.subarray(1, 4).toString(), "PNG");
  assert.ok(png.width > 0 && png.height > 0);
  assert.ok(png.width <= 4096 && png.height <= 4096);
});

test("wraps long labels without losing text", () => {
  const lines = wrapLabel("a-super-long-unbroken-identifier followed by words", 10);
  assert.ok(lines.every((line) => line.length <= 10));
  assert.equal(lines.join("").replace(/\s/g, ""), "a-super-long-unbroken-identifierfollowedbywords".replace(/\s/g, ""));
});
