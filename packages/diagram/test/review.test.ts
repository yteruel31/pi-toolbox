import assert from "node:assert/strict";
import test from "node:test";

import { layoutDiagram } from "../src/layout.js";
import { resolveScene } from "../src/render/scene.js";
import { renderSceneSvg } from "../src/render/svg.js";
import { annotateReview, reviewScene } from "../src/review.js";
import { normalizeSpec } from "../src/spec.js";

test("reports a clean model-space diagram without readability blockers", () => {
  const report = reviewScene(scene({
    nodes: [{ id: "a", label: "Browser" }, { id: "b", label: "API" }],
    edges: [{ id: "request", from: "a", to: "b", label: "HTTPS" }],
  }));
  assert.equal(report.counts.high, 0);
  assert.equal(report.counts.medium, 0);
});

test("detects model-space text overflow and WCAG contrast failures", () => {
  const overflowScene = scene({ nodes: [{ id: "narrow", label: "Text that cannot fit" }], edges: [] });
  overflowScene.nodes[0]!.bounds = { x: overflowScene.nodes[0]!.source.x - 20, y: overflowScene.nodes[0]!.source.y - 15, width: 40, height: 30 };
  assert.ok(reviewScene(overflowScene).findings.some((finding) => finding.rule === "text-overflow" && finding.elements[0] === "narrow"));

  const contrast = reviewScene(scene({ nodes: [{ id: "midtone", label: "Weak", fill: "#808080" }], edges: [] }));
  const finding = contrast.findings.find((candidate) => candidate.rule === "contrast");
  assert.equal(finding?.severity, "high");
  assert.ok(Number(finding?.metrics?.ratio) < 4.5);
});

test("detects edge-node, edge-crossing, and edge-text collisions", () => {
  const edgeNodeScene = scene({
    nodes: [{ id: "a", label: "A" }, { id: "middle", label: "Middle" }, { id: "b", label: "B" }],
    edges: [{ id: "a-b", from: "a", to: "b" }],
  });
  const middle = edgeNodeScene.nodes.find((node) => node.id === "middle")!.source;
  edgeNodeScene.edges[0]!.points = [{ x: middle.x - middle.width, y: middle.y }, { x: middle.x + middle.width, y: middle.y }];
  assert.ok(reviewScene(edgeNodeScene).findings.some((finding) => finding.rule === "edge-node" && finding.elements.includes("middle")));

  const crossingScene = scene({
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
    edges: [{ id: "first", from: "a", to: "b" }, { id: "second", from: "c", to: "d" }],
  });
  crossingScene.edges[0]!.points = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
  crossingScene.edges[1]!.points = [{ x: 0, y: 100 }, { x: 100, y: 0 }];
  assert.ok(reviewScene(crossingScene).findings.some((finding) => finding.rule === "edge-crossing"));

  const textScene = scene({
    nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }, { id: "d", label: "D" }],
    edges: [{ id: "labelled", from: "a", to: "b", label: "Protected label" }, { id: "other", from: "c", to: "d" }],
  });
  const label = textScene.edges[0]!.labelBounds!;
  textScene.edges[1]!.points = [{ x: label.x - 20, y: label.y + label.height / 2 }, { x: label.x + label.width + 20, y: label.y + label.height / 2 }];
  assert.ok(reviewScene(textScene).findings.some((finding) => finding.rule === "edge-text" && finding.elements.includes("labelled")));
});

test("suppresses crossings at a shared terminal node", () => {
  const current = scene({
    nodes: [{ id: "shared", label: "Shared", shape: "diamond" }, { id: "b", label: "B" }, { id: "c", label: "C" }],
    edges: [{ id: "first", from: "shared", to: "b" }, { id: "second", from: "shared", to: "c" }],
  });
  const shared = current.nodes.find((node) => node.id === "shared")!.source;
  current.edges[0]!.points = [{ x: shared.x, y: shared.y }, { x: shared.x + 100, y: shared.y }];
  current.edges[1]!.points = [{ x: shared.x, y: shared.y }, { x: shared.x, y: shared.y + 100 }];
  assert.equal(reviewScene(current).findings.some((finding) => finding.rule === "edge-crossing"), false);
});

test("detects group label collisions and inflates constrained node shapes", () => {
  const current = scene({
    groups: [{ id: "group", label: "Group label" }],
    nodes: [{ id: "member", label: "Member", group: "group" }],
    edges: [],
  });
  const label = current.groups[0]!.textLines[0]!.bounds;
  current.nodes[0]!.bounds = { ...label };
  assert.ok(reviewScene(current).findings.some((finding) => finding.rule === "group-label-node"));

  const rounded = layoutDiagram(normalizeSpec({ nodes: [{ id: "node", label: "Title", note: "Several words of supporting copy", shape: "rounded" }], edges: [] })).nodes[0]!;
  const diamond = layoutDiagram(normalizeSpec({ nodes: [{ id: "node", label: "Title", note: "Several words of supporting copy", shape: "diamond" }], edges: [] })).nodes[0]!;
  assert.ok(diamond.width > rounded.width);
  assert.ok(diamond.height > rounded.height);

  const detached = reviewScene(scene({ groups: [{ id: "empty", label: "Empty" }], nodes: [{ id: "node", label: "Node" }], edges: [] }));
  assert.ok(detached.findings.some((finding) => finding.rule === "empty-group" && finding.severity === "low"));
});

test("renders deterministic transient review annotations", () => {
  const current = scene({ nodes: [{ id: "midtone", label: "Weak", fill: "#808080" }], edges: [] });
  const rendered = renderSceneSvg("Review", current);
  const report = reviewScene(current);
  const first = annotateReview(rendered, report);
  const second = annotateReview(rendered, report);
  assert.equal(first.svg, second.svg);
  assert.match(first.svg, /id="diagram-review"/);
  assert.match(first.svg, /<circle/);
  assert.doesNotMatch(first.svg, /<script>|foreignObject/);
  assert.doesNotMatch(rendered.svg, /diagram-review/);
});

function scene(value: unknown) {
  return resolveScene(normalizeSpec(value));
}
