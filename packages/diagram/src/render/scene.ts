import { edgeLabelDimensions, layoutDiagram, type DiagramLayout, type LayoutEdge, type LayoutGroup, type LayoutNode, type Point } from "../layout.js";
import type { DiagramSpec, DiagramTheme, NodeShape } from "../spec.js";

export interface Palette {
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

export interface SceneRect { x: number; y: number; width: number; height: number }
export type SceneTextRole = "node-label" | "node-note" | "edge-label" | "group-label";
export interface SceneTextLine {
  ownerId: string;
  role: SceneTextRole;
  text: string;
  x: number;
  baseline: number;
  fontSize: number;
  fontWeight: number;
  fill: string;
  opacity: number;
  background: string;
  bounds: SceneRect;
}
export interface SceneNode {
  source: LayoutNode;
  id: string;
  shape: NodeShape;
  bounds: SceneRect;
  fill: string;
  textFill: string;
  textLines: SceneTextLine[];
}
export interface SceneEdge {
  source: LayoutEdge;
  id: string;
  points: Point[];
  labelBounds?: SceneRect;
  textLines: SceneTextLine[];
}
export interface SceneGroup {
  source: LayoutGroup;
  id: string;
  bounds: SceneRect;
  fill: string;
  compositedFill: string;
  textLines: SceneTextLine[];
}
export interface DiagramScene {
  layout: DiagramLayout;
  palette: Palette;
  nodes: SceneNode[];
  edges: SceneEdge[];
  groups: SceneGroup[];
}

export const PALETTES: Record<DiagramTheme, Palette> = {
  light: { surface: "#ffffff", node: "#ffffff", nodeStroke: "#3157d5", text: "#172036", muted: "#69728a", edge: "#64708c", edgeLabel: "#ffffff", group: "#edf2ff", groupStroke: "#9db1f1" },
  dark: { surface: "#0b1120", node: "#151f35", nodeStroke: "#6f8dff", text: "#f3f6ff", muted: "#a8b2ca", edge: "#9ba8c7", edgeLabel: "#151f35", group: "#101a30", groupStroke: "#40568f" },
  neutral: { surface: "#f6f5f2", node: "#fffefa", nodeStroke: "#4b5563", text: "#24282f", muted: "#707780", edge: "#767d86", edgeLabel: "#fffefa", group: "#eceae4", groupStroke: "#a7a39a" },
};

export function resolveScene(spec: DiagramSpec): DiagramScene {
  const layout = layoutDiagram(spec);
  const palette = PALETTES[spec.theme];
  const nodes = layout.nodes.map((node): SceneNode => {
    const bounds = centeredRect(node.x, node.y, node.width, node.height);
    const fill = node.fill ?? palette.node;
    const textFill = readableText(fill, palette.text);
    const textLines: SceneTextLine[] = [];
    const totalHeight = node.labelLines.length * 18 + node.noteLines.length * 15 + (node.noteLines.length ? 8 : 0);
    let baseline = node.y - totalHeight / 2 + 14;
    for (const text of node.labelLines) {
      textLines.push(sceneText(node.id, "node-label", text, node.x, baseline, 14, 650, textFill, 1, fill, 7.8));
      baseline += 18;
    }
    if (node.noteLines.length) baseline += 5;
    for (const text of node.noteLines) {
      textLines.push(sceneText(node.id, "node-note", text, node.x, baseline, 11.5, 400, textFill, 0.7, fill, 6.4));
      baseline += 15;
    }
    return { source: node, id: node.id, shape: node.shape ?? "rounded", bounds, fill, textFill, textLines };
  });

  const edges = layout.edges.map((edge): SceneEdge => {
    if (!edge.labelLines.length || edge.labelX === undefined || edge.labelY === undefined) {
      return { source: edge, id: edge.id, points: edge.points, textLines: [] };
    }
    const size = edgeLabelDimensions(edge.labelLines);
    const labelBounds = centeredRect(edge.labelX, edge.labelY, size.width, size.height);
    const textLines: SceneTextLine[] = [];
    let baseline = edge.labelY - (edge.labelLines.length - 1) * 7.5 + 4;
    for (const text of edge.labelLines) {
      textLines.push(sceneText(edge.id, "edge-label", text, edge.labelX, baseline, 12, 550, palette.muted, 1, palette.edgeLabel, 7.2));
      baseline += 15;
    }
    return { source: edge, id: edge.id, points: edge.points, labelBounds, textLines };
  });

  const groups = layout.groups.map((group): SceneGroup => {
    const fill = group.fill ?? palette.group;
    const compositedFill = compositeHex(fill, palette.surface, 0.7);
    const textLines = group.label
      ? [sceneText(group.id, "group-label", group.label, group.x + 16, group.y + 23, 12, 650, palette.muted, 1, compositedFill, 7.2, "start")]
      : [];
    return { source: group, id: group.id, bounds: { x: group.x, y: group.y, width: group.width, height: group.height }, fill, compositedFill, textLines };
  });

  return { layout, palette, nodes, edges, groups };
}

export function readableText(fill: string, fallback: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(fill);
  if (!match) return fallback;
  const value = Number.parseInt(match[1]!, 16);
  const red = (value >> 16) & 255;
  const green = (value >> 8) & 255;
  const blue = value & 255;
  return (red * 299 + green * 587 + blue * 114) / 1000 > 150 ? "#172036" : "#f7f9ff";
}

export function compositeHex(foreground: string, background: string, opacity: number): string {
  const front = rgb(foreground);
  const back = rgb(background);
  return `#${[front.red, front.green, front.blue].map((channel, index) => {
    const base = [back.red, back.green, back.blue][index]!;
    return Math.round(channel * opacity + base * (1 - opacity)).toString(16).padStart(2, "0");
  }).join("")}`;
}

function sceneText(
  ownerId: string,
  role: SceneTextRole,
  text: string,
  x: number,
  baseline: number,
  fontSize: number,
  fontWeight: number,
  fill: string,
  opacity: number,
  background: string,
  characterWidth: number,
  anchor: "middle" | "start" = "middle",
): SceneTextLine {
  const width = Math.max(characterWidth, text.length * characterWidth);
  const left = anchor === "middle" ? x - width / 2 : x;
  return {
    ownerId,
    role,
    text,
    x,
    baseline,
    fontSize,
    fontWeight,
    fill,
    opacity,
    background,
    bounds: { x: left, y: baseline - fontSize, width, height: fontSize + 3 },
  };
}

function centeredRect(x: number, y: number, width: number, height: number): SceneRect {
  return { x: x - width / 2, y: y - height / 2, width, height };
}

function rgb(hex: string): { red: number; green: number; blue: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) throw new Error(`Unsupported color: ${hex}`);
  const value = Number.parseInt(match[1]!, 16);
  return { red: (value >> 16) & 255, green: (value >> 8) & 255, blue: value & 255 };
}
