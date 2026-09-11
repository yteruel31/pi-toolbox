import { parentPort, workerData } from "node:worker_threads";
import { getDocumentProxy } from "unpdf";

// Plain ESM intentionally: PDF parsing never runs on the agent's event loop.
let pdf;
try {
  const { bytes, maxPages, maxTextBytes } = workerData;
  pdf = await getDocumentProxy(bytes, {
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    maxImageSize: 1_000_000,
    useWorkerFetch: false,
  });
  let content = "";
  let remaining = maxTextBytes - 256;
  let hasText = false;
  const append = (text) => {
    const buffer = Buffer.from(text);
    let end = Math.min(buffer.length, remaining);
    if (end < buffer.length) while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    content += buffer.subarray(0, end).toString("utf8");
    remaining -= end;
    return end === buffer.length;
  };
  pages: for (let number = 1; number <= Math.min(pdf.numPages, maxPages); number++) {
    const page = await pdf.getPage(number);
    const reader = page.streamTextContent().getReader();
    try {
      if (!append(`\n\n## Page ${number}\n\n`)) break;
      while (remaining > 0) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const item of value.items) {
          if (typeof item.str === "string") {
            if (item.str.trim()) hasText = true;
            if (!append(item.str + (item.hasEOL ? "\n" : " "))) break pages;
          }
        }
      }
    } finally {
      await reader.cancel();
      page.cleanup();
    }
    if (remaining === 0) break;
  }
  const metadata = await pdf.getMetadata();
  const rawTitle = typeof metadata.info?.Title === "string" ? metadata.info.Title : "";
  // Parent performs a final UTF-8 byte bound as well.
  if (!hasText) content = "No extractable text found. This PDF may be scanned; OCR is not supported.";
  if (pdf.numPages > maxPages || remaining === 0) content += "\n\n[PDF extraction truncated by page or text limit]";
  parentPort.postMessage({ title: rawTitle.slice(0, 1024), content: content.trim(), method: "pdf" });
} catch (error) {
  parentPort.postMessage({ error: `PDF extraction failed: ${String(error?.message ?? error).slice(0, 1000)}` });
} finally {
  if (typeof pdf?.destroy === "function") await pdf.destroy();
}
