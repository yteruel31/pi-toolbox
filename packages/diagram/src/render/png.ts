import { Resvg, renderAsync as renderResvgAsync } from "@resvg/resvg-js";

import type { SvgRenderResult } from "./svg.js";

const MAX_PNG_DIMENSION = 4_096;
const MAX_SVG_DIMENSION = 20_000;

export interface PngRenderResult {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
}

export function boundedPngScale(rendered: SvgRenderResult, requestedScale = 2, maximumDimension = MAX_PNG_DIMENSION): number {
  if (rendered.width > MAX_SVG_DIMENSION || rendered.height > MAX_SVG_DIMENSION) {
    throw new Error(`Diagram dimensions exceed ${MAX_SVG_DIMENSION}px; split it into smaller diagrams`);
  }
  if (!Number.isFinite(maximumDimension) || maximumDimension < 256 || maximumDimension > MAX_PNG_DIMENSION) throw new Error("Invalid PNG dimension limit");
  const scale = Math.min(requestedScale, maximumDimension / rendered.width, maximumDimension / rendered.height);
  if (!Number.isFinite(scale) || scale <= 0) throw new Error("Invalid PNG scale");
  return scale;
}

export function renderPng(rendered: SvgRenderResult, requestedScale = 2, maximumDimension = MAX_PNG_DIMENSION): PngRenderResult {
  const scale = boundedPngScale(rendered, requestedScale, maximumDimension);
  const image = new Resvg(rendered.svg, options(rendered.background, scale)).render();
  return result(image, scale);
}

export async function renderPngAsync(rendered: SvgRenderResult, requestedScale = 2, maximumDimension = MAX_PNG_DIMENSION): Promise<PngRenderResult> {
  const scale = boundedPngScale(rendered, requestedScale, maximumDimension);
  const image = await renderResvgAsync(rendered.svg, options(rendered.background, scale));
  return result(image, scale);
}

function options(background: string, scale: number) {
  return {
    background,
    fitTo: { mode: "zoom" as const, value: scale },
    font: { loadSystemFonts: true, defaultFontFamily: "sans-serif" },
  };
}

function result(image: { asPng(): Buffer | Uint8Array; width: number; height: number }, scale: number): PngRenderResult {
  return { png: Buffer.from(image.asPng()), width: image.width, height: image.height, scale };
}
