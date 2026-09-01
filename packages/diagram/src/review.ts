import type { Point } from "./layout.js";
import { compositeHex, type DiagramScene, type SceneNode, type SceneRect } from "./render/scene.js";
import type { SvgRenderResult } from "./render/svg.js";

export type ReviewSeverity = "high" | "medium" | "low" | "info";
export type ReviewRule =
  | "text-overflow"
  | "contrast"
  | "edge-node"
  | "edge-crossing"
  | "edge-text"
  | "edge-label-node"
  | "label-label"
  | "group-label-node"
  | "group-node"
  | "empty-group"
  | "node-node"
  | "png-scale-bounded";

export interface ReviewFinding {
  severity: ReviewSeverity;
  rule: ReviewRule;
  elements: string[];
  message: string;
  metrics?: Record<string, number | string>;
  bounds?: SceneRect;
  segment?: [Point, Point];
}

export interface ReviewReport {
  findings: ReviewFinding[];
  counts: Record<ReviewSeverity, number>;
  truncated: boolean;
}

export interface ReviewOptions {
  requestedScale?: number;
  renderedScale?: number;
  maximumFindings?: number;
}

const SAFE_INSET = 4;
const SEVERITY_ORDER: Record<ReviewSeverity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function reviewScene(scene: DiagramScene, options: ReviewOptions = {}): ReviewReport {
  if (scene.nodes.length === 0) return emptyReport();
  const findings: ReviewFinding[] = [];
  reviewText(scene, findings);
  reviewNodes(scene, findings);
  reviewEdges(scene, findings);
  reviewLabels(scene, findings);
  reviewGroups(scene, findings);
  if (options.requestedScale !== undefined && options.renderedScale !== undefined && options.renderedScale < options.requestedScale) {
    findings.push({
      severity: "info",
      rule: "png-scale-bounded",
      elements: [],
      message: `Inline PNG scale was reduced from ${format(options.requestedScale)}× to ${format(options.renderedScale)}× to stay within the image limit.`,
      metrics: { requestedScale: options.requestedScale, renderedScale: options.renderedScale },
      bounds: { x: 0, y: 0, width: scene.layout.width, height: scene.layout.height },
    });
  }
  findings.sort(compareFindings);
  const counts = countFindings(findings);
  const maximum = options.maximumFindings ?? 25;
  return { findings: findings.slice(0, maximum), counts, truncated: findings.length > maximum };
}

export function annotateReview(rendered: SvgRenderResult, report: ReviewReport, maximumAnnotations = 25): SvgRenderResult {
  const annotations = report.findings.slice(0, maximumAnnotations).flatMap((finding, index) => {
    const color = finding.severity === "high" ? "#dc2626" : finding.severity === "medium" ? "#ea580c" : finding.severity === "low" ? "#ca8a04" : "#2563eb";
    const pieces: string[] = [];
    let marker: Point | undefined;
    if (finding.bounds) {
      const bounds = expandRect(finding.bounds, 4);
      pieces.push(`<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" rx="6" fill="${color}" fill-opacity="0.08" stroke="${color}" stroke-width="3" stroke-dasharray="7 5"/>`);
      marker = { x: bounds.x + bounds.width, y: bounds.y };
    }
    if (finding.segment) {
      const [start, end] = finding.segment;
      pieces.push(`<path d="M ${number(start.x)} ${number(start.y)} L ${number(end.x)} ${number(end.y)}" fill="none" stroke="${color}" stroke-width="6" stroke-opacity="0.58" stroke-linecap="round"/>`);
      marker ??= { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
    }
    if (!marker) return pieces;
    const x = Math.max(12, Math.min(rendered.width - 12, marker.x));
    const y = Math.max(12, Math.min(rendered.height - 12, marker.y));
    pieces.push(`<circle cx="${number(x)}" cy="${number(y)}" r="11" fill="${color}" stroke="#ffffff" stroke-width="2"/><text x="${number(x)}" y="${number(y + 4)}" text-anchor="middle" fill="#ffffff" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="700">${index + 1}</text>`);
    return pieces;
  });
  if (annotations.length === 0) return rendered;
  const overlay = `<g id="diagram-review" pointer-events="none">${annotations.join("")}</g>`;
  return { ...rendered, svg: rendered.svg.replace("</svg>", `${overlay}</svg>`) };
}

export function reviewSummary(report: ReviewReport): string {
  const { high, medium, low, info } = report.counts;
  if (high + medium + low + info === 0) return "Review: no readability findings.";
  const parts = (["high", "medium", "low", "info"] as const)
    .filter((severity) => report.counts[severity] > 0)
    .map((severity) => `${report.counts[severity]} ${severity}`);
  return `Review: ${parts.join(", ")}${high + medium > 0 ? " — call review for the annotated image." : "."}`;
}

function reviewText(scene: DiagramScene, findings: ReviewFinding[]): void {
  for (const node of scene.nodes) {
    const overflow = node.textLines.filter((line) => !rectInsideNode(line.bounds, node, SAFE_INSET));
    if (overflow.length) findings.push({
      severity: "high",
      rule: "text-overflow",
      elements: [node.id],
      message: `${overflow.length} text line${overflow.length === 1 ? " exceeds" : "s exceed"} the safe interior of ${node.shape} node ${node.id}.`,
      metrics: { overflowingLines: overflow.length, totalLines: node.textLines.length },
      bounds: unionRects(overflow.map((line) => line.bounds)),
    });
  }

  const textLines = [
    ...scene.nodes.flatMap((node) => node.textLines),
    ...scene.edges.flatMap((edge) => edge.textLines),
    ...scene.groups.flatMap((group) => group.textLines),
  ];
  const weakest = new Map<string, { ratio: number; line: (typeof textLines)[number] }>();
  for (const line of textLines) {
    const visibleFill = line.opacity === 1 ? line.fill : compositeHex(line.fill, line.background, line.opacity);
    const ratio = contrastRatio(visibleFill, line.background);
    const key = `${line.ownerId}:${line.role}`;
    const previous = weakest.get(key);
    if (!previous || ratio < previous.ratio) weakest.set(key, { ratio, line });
  }
  for (const { ratio, line } of weakest.values()) if (ratio < 4.5) findings.push({
    severity: "high",
    rule: "contrast",
    elements: [line.ownerId],
    message: `${line.role} text on ${line.ownerId} has ${ratio.toFixed(2)}:1 contrast; WCAG AA requires 4.5:1.`,
    metrics: { ratio: Number(ratio.toFixed(3)), required: 4.5, role: line.role },
    bounds: line.bounds,
  });
}

function reviewNodes(scene: DiagramScene, findings: ReviewFinding[]): void {
  for (let leftIndex = 0; leftIndex < scene.nodes.length; leftIndex += 1) {
    const left = scene.nodes[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < scene.nodes.length; rightIndex += 1) {
      const right = scene.nodes[rightIndex]!;
      const overlap = intersectionRect(left.bounds, right.bounds);
      if (overlap) findings.push({
        severity: "medium",
        rule: "node-node",
        elements: [left.id, right.id],
        message: `Nodes ${left.id} and ${right.id} overlap.`,
        bounds: overlap,
      });
    }
  }
}

function reviewEdges(scene: DiagramScene, findings: ReviewFinding[]): void {
  for (const edge of scene.edges) {
    for (const node of scene.nodes) {
      if (node.id === edge.source.from || node.id === edge.source.to) continue;
      const segment = segments(edge.points).find(([start, end]) => segmentIntersectsNode(start, end, node));
      if (segment) findings.push({
        severity: "medium",
        rule: "edge-node",
        elements: [edge.id, node.id],
        message: `Edge ${edge.id} crosses unrelated node ${node.id}.`,
        bounds: node.bounds,
        segment,
      });
    }
  }

  for (let leftIndex = 0; leftIndex < scene.edges.length; leftIndex += 1) {
    const left = scene.edges[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < scene.edges.length; rightIndex += 1) {
      const right = scene.edges[rightIndex]!;
      const sharedNodeIds = [left.source.from, left.source.to].filter((id) => id === right.source.from || id === right.source.to);
      let crossing: { point: Point; segment: [Point, Point] } | undefined;
      for (const leftSegment of segments(left.points)) {
        for (const rightSegment of segments(right.points)) {
          const point = segmentIntersection(leftSegment[0], leftSegment[1], rightSegment[0], rightSegment[1]);
          if (!point) continue;
          if (sharedNodeIds.some((id) => {
            const node = scene.nodes.find((candidate) => candidate.id === id);
            return node ? pointInRect(point, node.bounds, 1) : false;
          })) continue;
          crossing = { point, segment: leftSegment };
          break;
        }
        if (crossing) break;
      }
      if (crossing) findings.push({
        severity: "medium",
        rule: "edge-crossing",
        elements: [left.id, right.id],
        message: `Edges ${left.id} and ${right.id} cross.`,
        bounds: { x: crossing.point.x - 5, y: crossing.point.y - 5, width: 10, height: 10 },
        segment: crossing.segment,
      });
    }
  }

  const protectedText = [
    ...scene.edges.flatMap((edge) => edge.textLines.map((line) => ({ edgeId: edge.id, line }))),
    ...scene.groups.flatMap((group) => group.textLines.map((line) => ({ edgeId: undefined, line }))),
  ];
  for (const edge of scene.edges) for (const target of protectedText) {
    if (target.edgeId === edge.id) continue;
    const segment = segments(edge.points).find(([start, end]) => segmentIntersectsRect(start, end, expandRect(target.line.bounds, 2)));
    if (segment) findings.push({
      severity: "medium",
      rule: "edge-text",
      elements: [edge.id, target.line.ownerId],
      message: `Edge ${edge.id} crosses ${target.line.role} text owned by ${target.line.ownerId}.`,
      bounds: target.line.bounds,
      segment,
    });
  }
}

function reviewLabels(scene: DiagramScene, findings: ReviewFinding[]): void {
  const labels = scene.edges.filter((edge) => edge.labelBounds);
  for (const edge of labels) for (const node of scene.nodes) {
    const overlap = intersectionRect(edge.labelBounds!, node.bounds);
    if (overlap) findings.push({
      severity: "medium",
      rule: "edge-label-node",
      elements: [edge.id, node.id],
      message: `Label for edge ${edge.id} overlaps node ${node.id}.`,
      bounds: overlap,
    });
  }
  for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
    const left = labels[leftIndex]!;
    const right = labels[rightIndex]!;
    const overlap = intersectionRect(left.labelBounds!, right.labelBounds!);
    if (overlap) findings.push({
      severity: "medium",
      rule: "label-label",
      elements: [left.id, right.id],
      message: `Edge labels ${left.id} and ${right.id} overlap.`,
      bounds: overlap,
    });
  }
}

function reviewGroups(scene: DiagramScene, findings: ReviewFinding[]): void {
  for (const group of scene.groups) {
    const members = scene.nodes.filter((node) => node.source.group === group.id);
    if (members.length === 0) findings.push({
      severity: "low",
      rule: "empty-group",
      elements: [group.id],
      message: `Group ${group.id} has no member nodes and renders as a detached label.`,
      bounds: group.bounds,
    });
    const label = group.textLines[0];
    if (label) for (const node of scene.nodes) {
      const overlap = intersectionRect(expandRect(label.bounds, 3), node.bounds);
      if (overlap) findings.push({
        severity: "medium",
        rule: "group-label-node",
        elements: [group.id, node.id],
        message: `Label for group ${group.id} overlaps node ${node.id}.`,
        bounds: overlap,
      });
    }
    for (const node of scene.nodes) {
      if (node.source.group === group.id) continue;
      const overlap = intersectionRect(group.bounds, node.bounds);
      if (overlap) findings.push({
        severity: "medium",
        rule: "group-node",
        elements: [group.id, node.id],
        message: `Group ${group.id} overlaps non-member node ${node.id}.`,
        bounds: overlap,
      });
    }
  }
}

function rectInsideNode(rect: SceneRect, node: SceneNode, inset: number): boolean {
  return corners(rect).every((point) => pointInsideNode(point, node, inset));
}

function pointInsideNode(point: Point, node: SceneNode, inset = 0): boolean {
  const centerX = node.bounds.x + node.bounds.width / 2;
  const centerY = node.bounds.y + node.bounds.height / 2;
  const radiusX = node.bounds.width / 2 - inset;
  const radiusY = node.bounds.height / 2 - inset;
  if (radiusX <= 0 || radiusY <= 0) return false;
  const dx = Math.abs(point.x - centerX);
  const dy = Math.abs(point.y - centerY);
  if (node.shape === "ellipse") return (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY) <= 1;
  if (node.shape === "diamond") return dx / radiusX + dy / radiusY <= 1;
  if (node.shape === "cylinder") {
    const cap = Math.min(14, node.bounds.height / 5);
    return dx <= radiusX && point.y >= node.bounds.y + cap + inset && point.y <= node.bounds.y + node.bounds.height - inset;
  }
  return dx <= radiusX && dy <= radiusY;
}

function segmentIntersectsNode(start: Point, end: Point, node: SceneNode): boolean {
  if (pointInsideNode(start, node) || pointInsideNode(end, node)) return true;
  if (node.shape === "ellipse") return segmentIntersectsEllipse(start, end, node.bounds);
  if (node.shape === "diamond") {
    const centerX = node.bounds.x + node.bounds.width / 2;
    const centerY = node.bounds.y + node.bounds.height / 2;
    const polygon = [
      { x: centerX, y: node.bounds.y },
      { x: node.bounds.x + node.bounds.width, y: centerY },
      { x: centerX, y: node.bounds.y + node.bounds.height },
      { x: node.bounds.x, y: centerY },
    ];
    return polygon.some((point, index) => segmentIntersection(start, end, point, polygon[(index + 1) % polygon.length]!) !== undefined);
  }
  return segmentIntersectsRect(start, end, node.bounds);
}

function segmentIntersectsEllipse(start: Point, end: Point, bounds: SceneRect): boolean {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const radiusX = bounds.width / 2;
  const radiusY = bounds.height / 2;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const x = start.x - centerX;
  const y = start.y - centerY;
  const a = (dx * dx) / (radiusX * radiusX) + (dy * dy) / (radiusY * radiusY);
  const b = 2 * ((x * dx) / (radiusX * radiusX) + (y * dy) / (radiusY * radiusY));
  const c = (x * x) / (radiusX * radiusX) + (y * y) / (radiusY * radiusY) - 1;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0 || a === 0) return false;
  const root = Math.sqrt(discriminant);
  const first = (-b - root) / (2 * a);
  const second = (-b + root) / (2 * a);
  return (first >= 0 && first <= 1) || (second >= 0 && second <= 1);
}

function segmentIntersectsRect(start: Point, end: Point, rect: SceneRect): boolean {
  if (pointInRect(start, rect) || pointInRect(end, rect)) return true;
  const edges: [Point, Point][] = [
    [{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y }],
    [{ x: rect.x + rect.width, y: rect.y }, { x: rect.x + rect.width, y: rect.y + rect.height }],
    [{ x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }],
    [{ x: rect.x, y: rect.y + rect.height }, { x: rect.x, y: rect.y }],
  ];
  return edges.some(([left, right]) => segmentIntersection(start, end, left, right) !== undefined);
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point | undefined {
  const denominator = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  const cross = (left: Point, middle: Point, right: Point) => (middle.x - left.x) * (right.y - left.y) - (middle.y - left.y) * (right.x - left.x);
  if (Math.abs(denominator) < 1e-9) {
    if (Math.abs(cross(a, b, c)) > 1e-7) return undefined;
    for (const point of [a, b, c, d]) if (onSegment(point, a, b) && onSegment(point, c, d)) return point;
    return undefined;
  }
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denominator;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / denominator;
  if (t < -1e-7 || t > 1 + 1e-7 || u < -1e-7 || u > 1 + 1e-7) return undefined;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function onSegment(point: Point, start: Point, end: Point): boolean {
  return point.x >= Math.min(start.x, end.x) - 1e-7 && point.x <= Math.max(start.x, end.x) + 1e-7
    && point.y >= Math.min(start.y, end.y) - 1e-7 && point.y <= Math.max(start.y, end.y) + 1e-7;
}

function segments(points: Point[]): [Point, Point][] {
  const result: [Point, Point][] = [];
  for (let index = 1; index < points.length; index += 1) result.push([points[index - 1]!, points[index]!]);
  return result;
}

function contrastRatio(foreground: string, background: string): number {
  const front = luminance(foreground);
  const back = luminance(background);
  return (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05);
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function corners(rect: SceneRect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

function pointInRect(point: Point, rect: SceneRect, inset = 0): boolean {
  return point.x >= rect.x + inset && point.x <= rect.x + rect.width - inset && point.y >= rect.y + inset && point.y <= rect.y + rect.height - inset;
}

function intersectionRect(left: SceneRect, right: SceneRect): SceneRect | undefined {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottom = Math.min(left.y + left.height, right.y + right.height);
  if (rightEdge - x <= 1 || bottom - y <= 1) return undefined;
  return { x, y, width: rightEdge - x, height: bottom - y };
}

function unionRects(rects: SceneRect[]): SceneRect {
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x, y, width: right - x, height: bottom - y };
}

function expandRect(rect: SceneRect, amount: number): SceneRect {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

function compareFindings(left: ReviewFinding, right: ReviewFinding): number {
  return SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]
    || left.rule.localeCompare(right.rule)
    || left.elements.join(":").localeCompare(right.elements.join(":"));
}

function countFindings(findings: ReviewFinding[]): Record<ReviewSeverity, number> {
  const counts: Record<ReviewSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

function emptyReport(): ReviewReport {
  return { findings: [], counts: { high: 0, medium: 0, low: 0, info: 0 }, truncated: false };
}

function format(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
