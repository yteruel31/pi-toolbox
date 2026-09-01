import { Resvg } from "@resvg/resvg-js";

import type { SvgRenderResult } from "./svg.js";

const MAX_PNG_DIMENSION = 4_096;
const MAX_SVG_DIMENSION = 20_000;

export interface PngRenderResult {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
}

export function renderPng(rendered: SvgRenderResult, requestedScale = 2, maximumDimension = MAX_PNG_DIMENSION): PngRenderResult {
  if (rendered.width > MAX_SVG_DIMENSION || rendered.height > MAX_SVG_DIMENSION) {
    throw new Error(`Diagram dimensions exceed ${MAX_SVG_DIMENSION}px; split it into smaller diagrams`);
  }
  if (!Number.isFinite(maximumDimension) || maximumDimension < 256 || maximumDimension > MAX_PNG_DIMENSION) throw new Error("Invalid PNG dimension limit");
  const scale = Math.min(requestedScale, maximumDimension / rendered.width, maximumDimension / rendered.height);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid PNG scale");
  const image = new Resvg(rendered.svg, {
    background: rendered.background,
    fitTo: { mode: "zoom", value: scale },
    font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" },
  }).render();
  return { png: Buffer.from(image.asPng()), width: image.width, height: image.height, scale };
}
