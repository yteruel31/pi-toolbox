import { graphlib, layout as runDagreLayout } from "@dagrejs/dagre";

import type { DiagramEdge, DiagramNode, DiagramSpec } from "./spec.js";

export interface Point { x: number; y: number }
export interface LayoutNode extends DiagramNode {
  x: number;
  y: number;
  width: number;
  height: number;
  labelLines: string[];
  noteLines: string[];
}
export interface LayoutEdge extends DiagramEdge {
  points: Point[];
  labelLines: string[];
  labelX?: number;
  labelY?: number;
}
export interface LayoutGroup {
  id: string;
  label?: string;
  fill?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DiagramLayout {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
}

const NODE_MIN_WIDTH = 144;
const NODE_MAX_WIDTH = 280;
const CHARACTER_WIDTH = 8.2;
const GROUP_PADDING = 28;

export function layoutDiagram(spec: DiagramSpec): DiagramLayout {
  if (spec.nodes.length === 0) return { width: 640, height: 360, nodes: [], edges: [], groups: [] };

  const graph = new graphlib.Graph({ multigraph: true });
  graph.setGraph({
    rankdir: spec.direction,
    nodesep: 44,
    ranksep: 74,
    edgesep: 20,
    marginx: 72,
    marginy: 72,
  });
  graph.setDefaultEdgeLabel(() => ({}));

  const dimensions = new Map<string, { width: number; height: number; labelLines: string[]; noteLines: string[] }>();
  for (const node of spec.nodes) {
    const labelLines = wrapLabel(node.label, 28);
    const noteLines = node.note ? wrapLabel(node.note, 34) : [];
    const longest = Math.max(8, ...labelLines.map((line) => line.length), ...noteLines.map((line) => line.length));
    const width = Math.min(NODE_MAX_WIDTH, Math.max(NODE_MIN_WIDTH, longest * CHARACTER_WIDTH + 42));
    const height = Math.max(60, 34 + labelLines.length * 18 + noteLines.length * 15 + (noteLines.length ? 8 : 0));
    dimensions.set(node.id, { width, height, labelLines, noteLines });
    graph.setNode(node.id, { width, height });
  }

  const edgeLabels = new Map<string, string[]>();
  for (const edge of spec.edges) {
    const labelLines = edge.label ? wrapLabel(edge.label, 28) : [];
    edgeLabels.set(edge.id, labelLines);
    const longest = Math.max(0, ...labelLines.map((line) => line.length));
    const labelWidth = labelLines.length ? Math.min(220, Math.max(40, longest * 7.2 + 18)) : 0;
    graph.setEdge(edge.from, edge.to, { width: labelWidth, height: labelLines.length ? labelLines.length * 15 + 9 : 0 }, edge.id);
  }
  runDagreLayout(graph);

  const nodes = spec.nodes.map((node): LayoutNode => {
    const positioned = graph.node(node.id) as { x: number; y: number; width: number; height: number };
    const measured = dimensions.get(node.id)!;
    return { ...node, ...positioned, labelLines: measured.labelLines, noteLines: measured.noteLines };
  });

  const edges = spec.edges.map((edge): LayoutEdge => {
    const positioned = graph.edge({ v: edge.from, w: edge.to, name: edge.id }) as { points?: Point[]; x?: number; y?: number } | undefined;
    return {
      ...edge,
      points: positioned?.points ?? [],
      labelLines: edgeLabels.get(edge.id) ?? [],
      ...(positioned?.x === undefined ? {} : { labelX: positioned.x }),
      ...(positioned?.y === undefined ? {} : { labelY: positioned.y }),
    };
  });

  const groups = spec.groups.map((group, index): LayoutGroup => {
    const members = nodes.filter((node) => node.group === group.id);
    if (members.length === 0) {
      return { ...group, x: 72 + index * 180, y: 26, width: 160, height: 44 };
    }
    const left = Math.min(...members.map((node) => node.x - node.width / 2)) - GROUP_PADDING;
    const right = Math.max(...members.map((node) => node.x + node.width / 2)) + GROUP_PADDING;
    const top = Math.min(...members.map((node) => node.y - node.height / 2)) - GROUP_PADDING - 18;
    const bottom = Math.max(...members.map((node) => node.y + node.height / 2)) + GROUP_PADDING;
    return { ...group, x: left, y: top, width: right - left, height: bottom - top };
  });

  const graphSize = graph.graph() as { width?: number; height?: number };
  const groupRight = Math.max(0, ...groups.map((group) => group.x + group.width + 32));
  const groupBottom = Math.max(0, ...groups.map((group) => group.y + group.height + 32));
  return {
    width: Math.ceil(Math.max(320, graphSize.width ?? 0, groupRight)),
    height: Math.ceil(Math.max(240, graphSize.height ?? 0, groupBottom)),
    nodes,
    edges,
    groups,
  };
}

export function wrapLabel(value: string, maximumCharacters: number): string[] {
  const result: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const words = rawLine.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      result.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      if (word.length > maximumCharacters) {
        if (line) result.push(line);
        for (let offset = 0; offset < word.length; offset += maximumCharacters) result.push(word.slice(offset, offset + maximumCharacters));
        line = "";
      } else if (!line) line = word;
      else if (`${line} ${word}`.length <= maximumCharacters) line += ` ${word}`;
      else {
        result.push(line);
        line = word;
      }
    }
    if (line) result.push(line);
  }
  return result.length ? result : [""];
}
