import { layoutDiagram, type LayoutEdge, type LayoutNode, type Point } from "../layout.js";
import type { DiagramSpec, DiagramTheme } from "../spec.js";

interface Palette {
  surface: string;
  node: string;
  nodeStroke: string;
  text: string;
  muted: string;
  edge: string;
  edgeLabel: string;
  group: string;
  groupStroke: string;
}

const PALETTES: Record<DiagramTheme, Palette> = {
  light: { surface: "#ffffff", node: "#ffffff", nodeStroke: "#3157d5", text: "#172036", muted: "#69728a", edge: "#64708c", edgeLabel: "#ffffff", group: "#edf2ff", groupStroke: "#9db1f1" },
  dark: { surface: "#0b1120", node: "#151f35", nodeStroke: "#6f8dff", text: "#f3f6ff", muted: "#a8b2ca", edge: "#9ba8c7", edgeLabel: "#151f35", group: "#101a30", groupStroke: "#40568f" },
  neutral: { surface: "#f6f5f2", node: "#fffefa", nodeStroke: "#4b5563", text: "#24282f", muted: "#707780", edge: "#767d86", edgeLabel: "#fffefa", group: "#eceae4", groupStroke: "#a7a39a" },
};

export interface SvgRenderResult {
  svg: string;
  width: number;
  height: number;
  background: string;
}

export function renderSvg(title: string, spec: DiagramSpec): SvgRenderResult {
  const layout = layoutDiagram(spec);
  const palette = PALETTES[spec.theme];
  const body: string[] = [];
  body.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${palette.edge}"/></marker></defs>`);

  for (const group of layout.groups) {
    body.push(`<rect x="${number(group.x)}" y="${number(group.y)}" width="${number(group.width)}" height="${number(group.height)}" rx="18" fill="${group.fill ?? palette.group}" fill-opacity="0.7" stroke="${palette.groupStroke}" stroke-width="1.5" stroke-dasharray="7 6"/>`);
    if (group.label) body.push(`<text x="${number(group.x + 16)}" y="${number(group.y + 23)}" fill="${palette.muted}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12" font-weight="650" letter-spacing="0.6">${escapeXml(group.label)}</text>`);
  }

  for (const edge of layout.edges) body.push(renderEdge(edge, palette));
  for (const node of layout.nodes) body.push(renderNode(node, palette));
  if (layout.nodes.length === 0) {
    body.push(`<rect x="160" y="96" width="320" height="168" rx="24" fill="${palette.node}" stroke="${palette.nodeStroke}" stroke-width="2" stroke-dasharray="8 8"/>`);
    body.push(`<text x="320" y="184" text-anchor="middle" fill="${palette.muted}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="18">Empty diagram</text>`);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-labelledby="diagram-title"><title id="diagram-title">${escapeXml(title)}</title>${body.join("")}</svg>`;
  return { svg, width: layout.width, height: layout.height, background: palette.surface };
}

function renderEdge(edge: LayoutEdge, palette: Palette): string {
  if (edge.points.length < 2) return "";
  const dash = edge.style === "dashed" ? "8 6" : edge.style === "dotted" ? "2 6" : undefined;
  const markers = edge.arrow === "none"
    ? ""
    : edge.arrow === "both"
      ? ` marker-start="url(#arrow)" marker-end="url(#arrow)"`
      : ` marker-end="url(#arrow)"`;
  const path = roundedPath(edge.points);
  const pieces = [`<path d="${path}" fill="none" stroke="${palette.edge}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"${dash ? ` stroke-dasharray="${dash}"` : ""}${markers}/>`];
  if (edge.labelLines.length && edge.labelX !== undefined && edge.labelY !== undefined) {
    const longest = Math.max(...edge.labelLines.map((line) => line.length));
    const width = Math.min(220, Math.max(40, longest * 7.2 + 18));
    const height = edge.labelLines.length * 15 + 9;
    pieces.push(`<rect x="${number(edge.labelX - width / 2)}" y="${number(edge.labelY - height / 2)}" width="${number(width)}" height="${number(height)}" rx="8" fill="${palette.edgeLabel}" stroke="${palette.edge}" stroke-opacity="0.24"/>`);
    let labelY = edge.labelY - (edge.labelLines.length - 1) * 7.5 + 4;
    for (const line of edge.labelLines) {
      pieces.push(`<text x="${number(edge.labelX)}" y="${number(labelY)}" text-anchor="middle" fill="${palette.muted}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" font-weight="550">${escapeXml(line)}</text>`);
      labelY += 15;
    }
  }
  return pieces.join("");
}

function renderNode(node: LayoutNode, palette: Palette): string {
  const left = node.x - node.width / 2;
  const top = node.y - node.height / 2;
  const fill = node.fill ?? palette.node;
  const text = readableText(fill, palette.text);
  const shape = node.shape ?? "rounded";
  const pieces: string[] = [];
  if (shape === "ellipse") {
    pieces.push(`<ellipse cx="${number(node.x)}" cy="${number(node.y)}" rx="${number(node.width / 2)}" ry="${number(node.height / 2)}" fill="${fill}" stroke="${palette.nodeStroke}" stroke-width="2"/>`);
  } else if (shape === "diamond") {
    pieces.push(`<path d="M ${number(node.x)} ${number(top)} L ${number(left + node.width)} ${number(node.y)} L ${number(node.x)} ${number(top + node.height)} L ${number(left)} ${number(node.y)} Z" fill="${fill}" stroke="${palette.nodeStroke}" stroke-width="2"/>`);
  } else if (shape === "cylinder") {
    const cap = Math.min(14, node.height / 5);
    pieces.push(`<path d="M ${number(left)} ${number(top + cap)} C ${number(left)} ${number(top - cap / 3)} ${number(left + node.width)} ${number(top - cap / 3)} ${number(left + node.width)} ${number(top + cap)} L ${number(left + node.width)} ${number(top + node.height - cap)} C ${number(left + node.width)} ${number(top + node.height + cap / 3)} ${number(left)} ${number(top + node.height + cap / 3)} ${number(left)} ${number(top + node.height - cap)} Z" fill="${fill}" stroke="${palette.nodeStroke}" stroke-width="2"/><path d="M ${number(left)} ${number(top + cap)} C ${number(left)} ${number(top + cap * 2)} ${number(left + node.width)} ${number(top + cap * 2)} ${number(left + node.width)} ${number(top + cap)}" fill="none" stroke="${palette.nodeStroke}" stroke-width="1.5"/>`);
  } else {
    pieces.push(`<rect x="${number(left)}" y="${number(top)}" width="${number(node.width)}" height="${number(node.height)}" rx="${shape === "rounded" ? 16 : 3}" fill="${fill}" stroke="${palette.nodeStroke}" stroke-width="2"/>`);
  }

  const totalHeight = node.labelLines.length * 18 + node.noteLines.length * 15 + (node.noteLines.length ? 8 : 0);
  let y = node.y - totalHeight / 2 + 14;
  for (const line of node.labelLines) {
    pieces.push(`<text x="${number(node.x)}" y="${number(y)}" text-anchor="middle" fill="${text}" font-family="ui-sans-serif, system-ui, sans-serif" font-size="14" font-weight="650">${escapeXml(line)}</text>`);
    y += 18;
  }
  if (node.noteLines.length) y += 5;
  for (const line of node.noteLines) {
    pieces.push(`<text x="${number(node.x)}" y="${number(y)}" text-anchor="middle" fill="${text}" fill-opacity="0.7" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11.5">${escapeXml(line)}</text>`);
    y += 15;
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

function readableText(fill: string, fallback: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(fill);
  if (!match) return fallback;
  const value = Number.parseInt(match[1]!, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#172036" : "#f7f9ff";
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[character]!);
}

function number(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
