import { escapeXml } from "../render/svg.js";

export function renderViewer(title: string, basePath: string): string {
  const prefix = basePath === "/" ? "" : basePath;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(title)} · Diagram</title>
<link rel="stylesheet" href="${prefix}/assets/viewer.css">
</head>
<body>
<header class="bar">
  <div class="identity">
    <span class="mark" aria-hidden="true"><i></i><i></i><i></i></span>
    <div><span class="eyebrow">PI / DIAGRAM</span><h1>${escapeXml(title)}</h1></div>
  </div>
  <div class="connection"><span class="pulse" aria-hidden="true"></span><span id="connection">Live</span></div>
</header>
<main>
  <nav class="tools" aria-label="Diagram controls">
    <div class="tool-group">
      <span class="tool-label">View</span>
      <button id="zoom-out" title="Zoom out" aria-label="Zoom out">−</button>
      <output id="zoom">100%</output>
      <button id="zoom-in" title="Zoom in" aria-label="Zoom in">+</button>
      <button id="fit">Fit</button>
      <button id="actual">100%</button>
    </div>
    <div class="tool-group backdrop-tools">
      <span class="tool-label">Board</span>
      <button class="swatch light" data-backdrop="light" aria-label="Light backdrop" title="Light backdrop"></button>
      <button class="swatch dark" data-backdrop="dark" aria-label="Dark backdrop" title="Dark backdrop"></button>
      <button class="swatch grid selected" data-backdrop="grid" aria-label="Grid backdrop" title="Grid backdrop"></button>
    </div>
    <div class="tool-group actions">
      <button id="copy-png">Copy image</button>
      <button id="copy-svg">Copy SVG</button>
      <a id="download-png" class="button" download>PNG ↓</a>
      <a id="download-svg" class="button" download>SVG ↓</a>
    </div>
  </nav>
  <section id="viewport" class="viewport backdrop-grid" aria-label="Diagram canvas" tabindex="0">
    <div class="axis axis-x"><span>0</span><span>250</span><span>500</span><span>750</span></div>
    <div class="axis axis-y"><span>0</span><span>250</span><span>500</span></div>
    <div id="sheet" class="sheet"><img id="diagram" alt="${escapeXml(title)}"></div>
  </section>
</main>
<div id="toast" role="status" aria-live="polite"></div>
<script src="${prefix}/assets/viewer.js" defer></script>
</body>
</html>`;
}
