import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const DIRECTIONS = ["TB", "LR", "BT", "RL"] as const;
export const THEMES = ["light", "dark", "neutral"] as const;
export const SHAPES = ["box", "rounded", "ellipse", "diamond", "cylinder"] as const;
export const EDGE_STYLES = ["solid", "dashed", "dotted"] as const;
export const ARROWS = ["none", "end", "both"] as const;
export const DIAGRAM_ACTIONS = ["create", "update", "render", "review", "inspect", "list", "delete"] as const;

export type Direction = (typeof DIRECTIONS)[number];
export type DiagramTheme = (typeof THEMES)[number];
export type NodeShape = (typeof SHAPES)[number];
export type EdgeStyle = (typeof EDGE_STYLES)[number];
export type ArrowStyle = (typeof ARROWS)[number];

export interface DiagramNode {
  id: string;
  label: string;
  shape?: NodeShape;
  group?: string;
  fill?: string;
  note?: string;
}

export interface DiagramEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
  arrow?: ArrowStyle;
}

export interface DiagramGroup {
  id: string;
  label?: string;
  fill?: string;
}

export interface DiagramSpec {
  direction: Direction;
  theme: DiagramTheme;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
}

export interface DiagramPatch {
  set_nodes?: DiagramNode[];
  remove_node_ids?: string[];
  set_edges?: DiagramEdge[];
  remove_edge_ids?: string[];
  set_groups?: DiagramGroup[];
  remove_group_ids?: string[];
  set_title?: string;
  set_theme?: DiagramTheme;
  set_direction?: Direction;
}

const idSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_.:-]*$" });
const labelSchema = Type.String({ minLength: 1, maxLength: 200 });
const colorSchema = Type.String({ pattern: "^#[0-9A-Fa-f]{6}$" });
const nodeSchema = Type.Object({
  id: idSchema,
  label: labelSchema,
  shape: Type.Optional(StringEnum(SHAPES)),
  group: Type.Optional(idSchema),
  fill: Type.Optional(colorSchema),
  note: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
}, { additionalProperties: false });
const edgeSchema = Type.Object({
  id: Type.Optional(idSchema),
  from: idSchema,
  to: idSchema,
  label: Type.Optional(labelSchema),
  style: Type.Optional(StringEnum(EDGE_STYLES)),
  arrow: Type.Optional(StringEnum(ARROWS)),
}, { additionalProperties: false });
const patchEdgeSchema = Type.Object({
  id: idSchema,
  from: idSchema,
  to: idSchema,
  label: Type.Optional(labelSchema),
  style: Type.Optional(StringEnum(EDGE_STYLES)),
  arrow: Type.Optional(StringEnum(ARROWS)),
}, { additionalProperties: false });
const groupSchema = Type.Object({
  id: idSchema,
  label: Type.Optional(labelSchema),
  fill: Type.Optional(colorSchema),
}, { additionalProperties: false });

export const diagramSpecSchema = Type.Object({
  direction: Type.Optional(StringEnum(DIRECTIONS)),
  theme: Type.Optional(StringEnum(THEMES)),
  nodes: Type.Array(nodeSchema, { maxItems: 300 }),
  edges: Type.Array(edgeSchema, { maxItems: 600 }),
  groups: Type.Optional(Type.Array(groupSchema, { maxItems: 50 })),
}, { additionalProperties: false });

export const diagramPatchSchema = Type.Object({
  set_nodes: Type.Optional(Type.Array(nodeSchema, { maxItems: 300 })),
  remove_node_ids: Type.Optional(Type.Array(idSchema, { maxItems: 300 })),
  set_edges: Type.Optional(Type.Array(patchEdgeSchema, { maxItems: 600 })),
  remove_edge_ids: Type.Optional(Type.Array(idSchema, { maxItems: 600 })),
  set_groups: Type.Optional(Type.Array(groupSchema, { maxItems: 50 })),
  remove_group_ids: Type.Optional(Type.Array(idSchema, { maxItems: 50 })),
  set_title: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  set_theme: Type.Optional(StringEnum(THEMES)),
  set_direction: Type.Optional(StringEnum(DIRECTIONS)),
}, { additionalProperties: false });

export const diagramToolSchema = Type.Object({
  action: StringEnum(DIAGRAM_ACTIONS),
  id: Type.Optional(Type.String({ description: "Diagram id returned by create" })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Human-readable diagram title" })),
  spec: Type.Optional(diagramSpecSchema),
  patch: Type.Optional(diagramPatchSchema),
  scale: Type.Optional(Type.Number({ minimum: 1, maximum: 4, description: "PNG scale (default 2)" })),
}, { additionalProperties: false });

export type DiagramToolInput = Static<typeof diagramToolSchema>;

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const allowedKeys = (value: Record<string, unknown>, keys: readonly string[], path: string): void => {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`${path}.${unknown} is not supported`);
};
const objectValue = (value: unknown, path: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} must be a plain object`);
  return value as Record<string, unknown>;
};
const textValue = (value: unknown, path: string, maximum: number, required = true): string | undefined => {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || (required && value.length === 0) || value.length > maximum || CONTROL_PATTERN.test(value)) {
    throw new Error(`${path} must be ${required ? "a non-empty" : "a"} string of at most ${maximum} characters`);
  }
  return value;
};
const idValue = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${path} must match ${ID_PATTERN}`);
  return value;
};
const colorValue = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !COLOR_PATTERN.test(value)) throw new Error(`${path} must be a six-digit hex color`);
  return value.toLowerCase();
};
const enumValue = <T extends string>(value: unknown, values: readonly T[], fallback: T, path: string): T => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${path} must be one of ${values.join(", ")}`);
  return value as T;
};
const optionalEnum = <T extends string>(value: unknown, values: readonly T[], path: string): T | undefined => {
  if (value === undefined) return undefined;
  return enumValue(value, values, values[0]!, path);
};

export function normalizeSpec(value: unknown): DiagramSpec {
  const spec = objectValue(value, "spec");
  allowedKeys(spec, ["direction", "theme", "nodes", "edges", "groups"], "spec");
  if (!Array.isArray(spec.nodes) || spec.nodes.length > 300) throw new Error("spec.nodes must contain at most 300 nodes");
  if (!Array.isArray(spec.edges) || spec.edges.length > 600) throw new Error("spec.edges must contain at most 600 edges");
  const groupInput = spec.groups ?? [];
  if (!Array.isArray(groupInput) || groupInput.length > 50) throw new Error("spec.groups must contain at most 50 groups");

  const groups = groupInput.map((candidate, index): DiagramGroup => {
    const group = objectValue(candidate, `spec.groups[${index}]`);
    allowedKeys(group, ["id", "label", "fill"], `spec.groups[${index}]`);
    return {
      id: idValue(group.id, `spec.groups[${index}].id`),
      ...(group.label === undefined ? {} : { label: textValue(group.label, `spec.groups[${index}].label`, 200)! }),
      ...(group.fill === undefined ? {} : { fill: colorValue(group.fill, `spec.groups[${index}].fill`)! }),
    };
  });
  assertUnique(groups.map(({ id }) => id), "group");
  const groupIds = new Set(groups.map(({ id }) => id));

  const nodes = spec.nodes.map((candidate, index): DiagramNode => {
    const node = objectValue(candidate, `spec.nodes[${index}]`);
    allowedKeys(node, ["id", "label", "shape", "group", "fill", "note"], `spec.nodes[${index}]`);
    const group = node.group === undefined ? undefined : idValue(node.group, `spec.nodes[${index}].group`);
    if (group && !groupIds.has(group)) throw new Error(`spec.nodes[${index}].group references unknown group ${group}`);
    return {
      id: idValue(node.id, `spec.nodes[${index}].id`),
      label: textValue(node.label, `spec.nodes[${index}].label`, 200)!,
      ...(node.shape === undefined ? {} : { shape: optionalEnum(node.shape, SHAPES, `spec.nodes[${index}].shape`)! }),
      ...(group ? { group } : {}),
      ...(node.fill === undefined ? {} : { fill: colorValue(node.fill, `spec.nodes[${index}].fill`)! }),
      ...(node.note === undefined ? {} : { note: textValue(node.note, `spec.nodes[${index}].note`, 240)! }),
    };
  });
  assertUnique(nodes.map(({ id }) => id), "node");
  const nodeIds = new Set(nodes.map(({ id }) => id));

  const seenEdgeIds = new Set<string>();
  const edges = spec.edges.map((candidate, index): DiagramEdge => {
    const edge = objectValue(candidate, `spec.edges[${index}]`);
    allowedKeys(edge, ["id", "from", "to", "label", "style", "arrow"], `spec.edges[${index}]`);
    const from = idValue(edge.from, `spec.edges[${index}].from`);
    const to = idValue(edge.to, `spec.edges[${index}].to`);
    if (!nodeIds.has(from) || !nodeIds.has(to)) throw new Error(`spec.edges[${index}] references an unknown node`);
    const id = edge.id === undefined ? generatedEdgeId(from, to, index) : idValue(edge.id, `spec.edges[${index}].id`);
    if (seenEdgeIds.has(id)) throw new Error(`Duplicate edge id: ${id}`);
    seenEdgeIds.add(id);
    return {
      id,
      from,
      to,
      ...(edge.label === undefined ? {} : { label: textValue(edge.label, `spec.edges[${index}].label`, 200)! }),
      ...(edge.style === undefined ? {} : { style: optionalEnum(edge.style, EDGE_STYLES, `spec.edges[${index}].style`)! }),
      ...(edge.arrow === undefined ? {} : { arrow: optionalEnum(edge.arrow, ARROWS, `spec.edges[${index}].arrow`)! }),
    };
  });

  return {
    direction: enumValue(spec.direction, DIRECTIONS, "TB", "spec.direction"),
    theme: enumValue(spec.theme, THEMES, "light", "spec.theme"),
    nodes,
    edges,
    groups,
  };
}

export function applyPatch(current: DiagramSpec, patchValue: unknown): { spec: DiagramSpec; title?: string } {
  const patch = objectValue(patchValue, "patch");
  allowedKeys(patch, ["set_nodes", "remove_node_ids", "set_edges", "remove_edge_ids", "set_groups", "remove_group_ids", "set_title", "set_theme", "set_direction"], "patch");
  const removeNodes = idSet(patch.remove_node_ids, "patch.remove_node_ids", 300);
  const removeEdges = idSet(patch.remove_edge_ids, "patch.remove_edge_ids", 600);
  const removeGroups = idSet(patch.remove_group_ids, "patch.remove_group_ids", 50);
  const setNodes = arrayValue(patch.set_nodes, "patch.set_nodes", 300);
  const setEdges = arrayValue(patch.set_edges, "patch.set_edges", 600);
  const setGroups = arrayValue(patch.set_groups, "patch.set_groups", 50);

  const mergeById = <T extends { id: string }>(existing: T[], additions: T[]): T[] => {
    const additionsById = new Map(additions.map((item) => [item.id, item]));
    const merged = existing.filter((item) => !additionsById.has(item.id)).concat(additions);
    return merged;
  };

  const candidate = {
    direction: patch.set_direction ?? current.direction,
    theme: patch.set_theme ?? current.theme,
    groups: mergeById(current.groups.filter(({ id }) => !removeGroups.has(id)), setGroups as DiagramGroup[]),
    nodes: mergeById(current.nodes.filter(({ id }) => !removeNodes.has(id)), setNodes as DiagramNode[]),
    edges: mergeById(current.edges.filter(({ id, from, to }) => !removeEdges.has(id) && !removeNodes.has(from) && !removeNodes.has(to)), setEdges as DiagramEdge[]),
  };
  const spec = normalizeSpec(candidate);
  const title = patch.set_title === undefined ? undefined : textValue(patch.set_title, "patch.set_title", 120)!;
  return { spec, ...(title ? { title } : {}) };
}

function generatedEdgeId(from: string, to: string, index: number): string {
  const base = `edge:${from}:${to}:${index}`;
  return base.length <= 64 ? base : `edge:${index}`;
}

function assertUnique(ids: string[], type: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${type} id`);
}

function arrayValue(value: unknown, path: string, maximum: number): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${path} must contain at most ${maximum} items`);
  return value;
}

function idSet(value: unknown, path: string, maximum: number): Set<string> {
  return new Set(arrayValue(value, path, maximum).map((id, index) => idValue(id, `${path}[${index}]`)));
}
