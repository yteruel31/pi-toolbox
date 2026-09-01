import { DEFAULT_MAX_BYTES, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { renderPng } from "./render/png.js";
import { resolveScene } from "./render/scene.js";
import { renderSceneSvg } from "./render/svg.js";
import { annotateReview, reviewScene, reviewSummary, type ReviewReport } from "./review.js";
import type { DiagramService } from "./service.js";
import { applyPatch, diagramToolSchema, normalizeSpec, type DiagramToolInput } from "./spec.js";
import type { DiagramDocument } from "./store.js";

export interface DiagramToolDetails {
  action: string;
  id?: string;
  title?: string;
  url?: string;
  revision?: number;
  nodes?: number;
  edges?: number;
  width?: number;
  height?: number;
  review?: ReviewReport["counts"];
}

export function registerDiagramTool(pi: ExtensionAPI, getService: () => Promise<DiagramService>): void {
  pi.registerTool({
    name: "diagram",
    label: "Diagram",
    description: "Create, edit, render, review, inspect, list, or delete hosted box-and-arrow diagrams. Mutating actions return an inline PNG, readability findings, and a live viewer URL; review returns an annotated PNG.",
    promptSnippet: "Create and host structured box-and-arrow diagrams with inline PNG previews.",
    promptGuidelines: [
      "Use diagram create with the complete graph in one call; use update patches for later focused changes.",
      "Keep node and edge ids stable across updates so patches remain reviewable.",
      "After create or update, inspect the returned image and review summary; call review for annotations, then update high or medium findings before finishing.",
      "Diagram viewer links are capability URLs and remain active only while Pi is running.",
    ],
    parameters: diagramToolSchema,
    async execute(_toolCallId, input: DiagramToolInput, signal, onUpdate) {
      if (signal?.aborted) throw new Error("Diagram operation aborted");
      onUpdate?.({ content: [{ type: "text", text: `Diagram ${input.action}…` }], details: undefined });
      const service = await getService();
      switch (input.action) {
        case "create": {
          if (!input.spec) throw new Error("create requires spec");
          const spec = normalizeSpec(input.spec);
          const title = titleValue(input.title ?? "Untitled diagram");
          const host = await service.ensureHost();
          const document = await service.store.create(title, spec);
          return imageResult("create", document, host.urlFor(document), input.scale);
        }
        case "update": {
          const id = idValue(input.id);
          if ((input.spec ? 1 : 0) + (input.patch ? 1 : 0) !== 1) throw new Error("update requires exactly one of spec or patch");
          const host = await service.ensureHost();
          const replacement = input.spec ? normalizeSpec(input.spec) : undefined;
          const explicitTitle = input.title ? titleValue(input.title) : undefined;
          const document = await service.store.updateWith(id, (current) => {
            if (replacement) return { spec: replacement, ...(explicitTitle ? { title: explicitTitle } : {}) };
            const patched = applyPatch(current.spec, input.patch);
            return { spec: patched.spec, ...(explicitTitle ? { title: explicitTitle } : patched.title ? { title: patched.title } : {}) };
          });
          host.notifyUpdated(document);
          return imageResult("update", document, host.urlFor(document), input.scale);
        }
        case "render": {
          const document = await requiredDocument(service, idValue(input.id));
          const host = await service.ensureHost();
          return imageResult("render", document, host.urlFor(document), input.scale);
        }
        case "review": {
          const document = await requiredDocument(service, idValue(input.id));
          return reviewResult(document, input.scale);
        }
        case "inspect": {
          const document = await requiredDocument(service, idValue(input.id));
          const host = await service.ensureHost();
          const url = host.urlFor(document);
          const serialized = JSON.stringify({
            id: document.id,
            title: document.title,
            revision: document.revision,
            createdAt: document.createdAt,
            updatedAt: document.updatedAt,
            url,
            spec: document.spec,
          }, null, 2);
          const bounded = truncateHead(serialized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2_000 });
          return {
            content: [{ type: "text" as const, text: `${bounded.content}${bounded.truncated ? "\n... diagram spec truncated at Pi's tool output limit" : ""}` }],
            details: detailsFor("inspect", document, url),
          };
        }
        case "list": {
          const host = await service.ensureHost();
          const documents = await service.store.list();
          const lines = documents.length
            ? documents.map((document) => `${document.id}\t${document.title}\tr${document.revision}\t${host.urlFor(document)}`)
            : ["No diagrams."];
          lines.push("Links are active while Pi is running.");
          return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { action: "list" } satisfies DiagramToolDetails };
        }
        case "delete": {
          const id = idValue(input.id);
          const document = await service.store.get(id);
          if (!document) throw new Error(`Unknown diagram: ${id}`);
          const deleted = await service.store.delete(id);
          if (!deleted) throw new Error(`Unknown diagram: ${id}`);
          service.notifyDeleted(id);
          return { content: [{ type: "text" as const, text: `Deleted ${id}; its capability URL now returns 404.` }], details: { action: "delete", id } satisfies DiagramToolDetails };
        }
      }
    },
  });
}

async function requiredDocument(service: DiagramService, id: string): Promise<DiagramDocument> {
  const document = await service.store.get(id);
  if (!document) throw new Error(`Unknown diagram: ${id}`);
  return document;
}

function imageResult(action: "create" | "update" | "render", document: DiagramDocument, url: string, scale = 2) {
  const scene = resolveScene(document.spec);
  const svg = renderSceneSvg(document.title, scene);
  const rendered = renderPng(svg, scale, 2_048);
  const report = reviewScene(scene, { requestedScale: scale, renderedScale: rendered.scale });
  const effectiveScale = rendered.scale === scale ? `${scale}×` : `${rendered.scale.toFixed(2)}× (bounded)`;
  const text = [
    `${document.id} · ${document.title} · revision ${document.revision}`,
    `Viewer: ${url}`,
    `PNG: ${rendered.width}×${rendered.height} at ${effectiveScale}`,
    ...(action === "create" || action === "update" ? [reviewSummary(report)] : []),
    "Link active while Pi is running.",
  ].join("\n");
  return {
    content: [
      { type: "text" as const, text },
      { type: "image" as const, data: rendered.png.toString("base64"), mimeType: "image/png" },
    ],
    details: { ...detailsFor(action, document, url), width: rendered.width, height: rendered.height, review: report.counts } satisfies DiagramToolDetails,
  };
}

function reviewResult(document: DiagramDocument, scale = 2) {
  const scene = resolveScene(document.spec);
  const svg = renderSceneSvg(document.title, scene);
  const original = renderPng(svg, scale, 2_048);
  const report = reviewScene(scene, { requestedScale: scale, renderedScale: original.scale });
  const annotated = renderPng(annotateReview(svg, report), scale, 2_048);
  const lines = report.findings.map((finding, index) => {
    const elements = finding.elements.length ? ` [${finding.elements.join(", ")}]` : "";
    return `${index + 1}. ${finding.severity.toUpperCase()} ${finding.rule}${elements} — ${finding.message}`;
  });
  const serialized = [
    `${document.id} · ${document.title} · revision ${document.revision}`,
    reviewSummary(report),
    ...(lines.length ? lines : ["No annotations required."]),
    ...(report.truncated ? ["Additional findings were truncated."] : []),
  ].join("\n");
  const bounded = truncateHead(serialized, { maxBytes: DEFAULT_MAX_BYTES, maxLines: 2_000 });
  return {
    content: [
      { type: "text" as const, text: `${bounded.content}${bounded.truncated ? "\n... review truncated at Pi's tool output limit" : ""}` },
      { type: "image" as const, data: annotated.png.toString("base64"), mimeType: "image/png" },
    ],
    details: {
      ...detailsFor("review", document),
      width: annotated.width,
      height: annotated.height,
      review: report.counts,
    } satisfies DiagramToolDetails,
  };
}

function detailsFor(action: string, document: DiagramDocument, url?: string): DiagramToolDetails {
  return {
    action,
    id: document.id,
    title: document.title,
    ...(url ? { url } : {}),
    revision: document.revision,
    nodes: document.spec.nodes.length,
    edges: document.spec.edges.length,
  };
}

function idValue(value: unknown): string {
  if (typeof value !== "string" || !/^diag_[0-9a-f]{12}$/.test(value)) throw new Error("A valid diagram id is required");
  return value;
}

function titleValue(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("title must be a non-empty string of at most 120 characters");
  return value;
}
