import type { Point } from "../layout.js";
import type { DiagramSpec } from "../spec.js";
import { resolveScene, type DiagramScene, type Palette, type SceneEdge, type SceneNode } from "./scene.js";

export interface SvgRenderResult {
  svg: string;
  width: number;
  height: number;
  background: string;
}

export function renderSvg(title: string, spec: DiagramSpec): SvgRenderResult {
  return renderSceneSvg(title, resolveScene(spec));
}

export function renderSceneSvg(title: string, scene: DiagramScene): SvgRenderResult {
  const { layout, palette } = scene;
  const body: string[] = [];
  body.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.edge}"/></marker></defs>`);

  for (const group of scene.groups) {
    const { source } = group;
    body.push(`<rect x="${number(source.x)}" y="${number(source.y)}" width="${number(source.width)}" height="${number(source.height)}" rx="18" fill="${group.fill}" fill-opacity="0.7" stroke="${palette.groupStroke}" stroke-width="1.5" stroke-dasharray="7 6"/>`);
    const line = group.textLines[0];
    if (line) body.push(`<text x="${number(line.x)}" y="${number(line.baseline)}" fill="${line.fill}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="650" letter-spacing="0.6">${escapeXml(line.text)}</text>`);
  }

  for (const edge of scene.edges) body.push(renderEdge(edge, palette));
  for (const node of scene.nodes) body.push(renderNode(node, palette));
  if (layout.nodes.length === 0) {
    body.push(`<rect x="160" y="96" width="320" height="168" rx="24" fill="${palette.node}" stroke="${palette.nodeStroke}" stroke-width="2" stroke-dasharray="8 8"/>`);
    body.push(`<text x="320" y="184" text-anchor="middle" fill="${palette.muted}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Empty diagram</text>`);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="diagram-title"><title id="diagram-title">${escapeXml(title)}</title>${body.join("")}</svg>`;
  return { svg, width: layout.width, height: layout.height, background: palette.surface };
}

function renderEdge(edge: SceneEdge, palette: Palette): string {
  const { source } = edge;
  if (edge.points.length < 2) return "";
  const dash = source.style === "dashed" ? "8 6" : source.style === "dotted" ? "2 6" : undefined;
  const markers = source.arrow === "none"
    ? ""
    : source.arrow === "both"
      ? ` marker-start="url(#arrow)" marker-end="url(#arrow)"`
      : ` marker-end="url(#arrow)"`;
  const path = roundedPath(edge.points);
  const pieces = [`<path d="${path}" fill="none" stroke="${palette.edge}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${markers}/>`];
  if (edge.labelBounds) {
    const bounds = edge.labelBounds;
    pieces.push(`<rect x="${number(bounds.x)}" y="${number(bounds.y)}" width="${number(bounds.width)}" height="${number(bounds.height)}" rx="8" fill="${palette.edgeLabel}" stroke="${palette.edge}" stroke-opacity="0.24"/>`);
    for (const line of edge.textLines) {
      pieces.push(`<text x="${number(line.x)}" y="${number(line.baseline)}" text-anchor="middle" fill="${line.fill}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" font-weight="550">${escapeXml(line.text)}</text>`);
    }
  }
  return pieces.join("");
}

function renderNode(node: SceneNode, palette: Palette): string {
  const { source, bounds, shape } = node;
  const left = bounds.x;
  const top = bounds.y;
  const pieces: string[] = [];
  if (shape === "ellipse") {
    pieces.push(`<ellipse cx="${number(source.x)}" cy="${number(source.y)}" rx="${number(source.width / 2)}" ry="${number(source.height / 2)}" fill="${node.fill}" stroke="${palette.nodeStroke}" stroke-width="2"/>`);
  } else if (shape === "diamond") {
    pieces.push(`<path d="M ${number(source.x)} ${number(top)} L ${number(left + source.width)} ${number(source.y)} L ${number(source.x)} ${number(top + source.height)} L ${number(left)} ${number(source.y)} Z" fill="${node.fill}" stroke="${palette.nodeStroke}" stroke-width="2"/>`);
  } else if (shape === "cylinder") {
    const cap = Math.min(14, source.height / 5);
    pieces.push(`<path d="M ${number(left)} ${number(top + cap)} C ${number(left)} ${number(top - cap / 3)} ${number(left + source.width)} ${number(top - cap / 3)} ${number(left + source.width)} ${number(top + cap)} L ${number(left + source.width)} ${number(top + source.height - cap)} C ${number(left + source.width)} ${number(top + source.height + cap / 3)} ${number(left)} ${number(top + source.height + cap / 3)} ${number(left)} ${number(top + source.height - cap)} Z" fill="${node.fill}" stroke="${palette.nodeStroke}" stroke-width="2"/><path d="M ${number(left)} ${number(top + cap)} C ${number(left)} ${number(top + cap * 2)} ${number(left + source.width)} ${number(top + cap * 2)} ${number(left + source.width)} ${number(top + cap)}" fill="none" stroke="${palette.nodeStroke}" stroke-width="1.5"/>`);
  } else {
    pieces.push(`<rect x="${number(left)}" y="${number(top)}" width="${number(source.width)}" height="${number(source.height)}" rx="${shape === "rounded" ? 16 : 3}" fill="${node.fill}" stroke="${palette.nodeStroke}" stroke-width="2"/>`);
  }

  for (const line of node.textLines) {
    const isNote = line.role === "node-note";
    pieces.push(`<text x="${number(line.x)}" y="${number(line.baseline)}" text-anchor="middle" fill="${line.fill}"${isNote ? ` fill-opacity="${line.opacity}"` : ""} font-family="ui-sans-serif, system-ui, sans-serif" font-size="${line.fontSize}"${isNote ? "" : ` font-weight="${line.fontWeight}"`}>${escapeXml(line.text)}</text>`);
  }
  return pieces.join("");
}

function roundedPath(points: Point[]): string {
  if (points.length < 2) return "";
  const commands = [`M ${number(points[0]!.x)} ${number(points[0]!.y)}`];
  for (let index = 1; index < points.length; index += 1) {
    const current = points[index]!;
    commands.push(`L ${number(current.x)} ${number(current.y)}`);
  }
  return commands.join(" ");
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
