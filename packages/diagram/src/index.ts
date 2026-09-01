import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerDiagramCommand } from "./commands.js";
import { DiagramRuntimeController } from "./runtime.js";
import { registerDiagramTool } from "./tool.js";

/** Registers lazy diagram entry points. No listener, process, or network starts during extension loading. */
export default function diagramExtension(pi: ExtensionAPI): void {
  const runtime = new DiagramRuntimeController();
  const getService = () => runtime.getService();

  registerDiagramTool(pi, getService);
  registerDiagramCommand(pi, {
    getService,
    transactConfig: (config, operation) => runtime.transactConfig(config, operation),
  });

  pi.on("session_start", () => runtime.reset());
  pi.on("session_shutdown", () => runtime.shutdown());
}

export { DEFAULT_HOSTING_SETTINGS, diagramConfigPath, loadDiagramConfig, parseDiagramConfig } from "./config.js";
export type { DiagramConfig, DiagramHostingSettings, HostingMode } from "./config.js";
export { layoutDiagram } from "./layout.js";
export { renderPng } from "./render/png.js";
export { renderSvg } from "./render/svg.js";
export { DiagramRuntimeController } from "./runtime.js";
export { DiagramService } from "./service.js";
export { applyPatch, normalizeSpec } from "./spec.js";
export type { DiagramEdge, DiagramGroup, DiagramNode, DiagramPatch, DiagramSpec } from "./spec.js";
export { DiagramStore } from "./store.js";
