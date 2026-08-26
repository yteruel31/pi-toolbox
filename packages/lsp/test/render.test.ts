import assert from "node:assert/strict";
import test from "node:test";

import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";

import { renderDiagnosticCard } from "../src/render.js";
import type { DiagnosticCardData } from "../src/types.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("diagnostic cards are compact and strip terminal control sequences", () => {
  initTheme("dark");
  const card: DiagnosticCardData = {
    file: "src/\u001b[31ma.ts",
    server: "fake",
    delayed: false,
    cleared: false,
    counts: { errors: 4, warnings: 0, information: 0, hints: 0 },
    diagnostics: Array.from({ length: 4 }, (_, line) => ({
      range: { start: { line, character: 0 }, end: { line, character: 1 } },
      severity: 1 as const,
      source: "fake",
      code: line,
      message: `bad\u001b]8;;https://example.com\u0007message ${line}`,
    })),
    omitted: 0,
  };

  const compact = renderDiagnosticCard(card, false, theme).render(120).join("\n");
  assert.equal(compact.includes("\u001b[31m"), false);
  assert.equal(compact.includes("https://example.com"), false);
  assert.match(compact, /1 more/);
  assert.doesNotMatch(compact, /message 3/);

  const expanded = renderDiagnosticCard(card, true, theme).render(120).join("\n");
  assert.match(expanded, /message 3/);
});
