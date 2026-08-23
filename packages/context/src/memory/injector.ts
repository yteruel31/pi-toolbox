import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { MemoryStore } from "./store.js";
import { MEMORY_CUSTOM_TYPE, MEMORY_MAX_INJECTION_BYTES } from "./schema.js";

const OPEN = "<memory>";
const CLOSE = "</memory>";
const TRUNCATED = "… (truncated)";

export function canonicalProject(cwd: string): string {
  return path.resolve(cwd);
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function buildMemoryInjection(
  store: MemoryStore,
  project: string,
  maxBytes = MEMORY_MAX_INJECTION_BYTES
) {
  const facts = store.listFacts(100);
  const lessons = store.listLessons(undefined, 100, project);
  if (facts.length === 0 && lessons.length === 0) {
    return {
      text: "",
      details: { facts: 0, lessons: 0, truncated: false, project },
    };
  }

  if (maxBytes < bytes(`${OPEN}\n${CLOSE}`)) {
    return {
      text: "",
      details: { facts: 0, lessons: 0, truncated: true, project },
    };
  }

  const candidates = [
    { text: "## Facts", kind: "heading" },
    ...facts.map((fact) => ({
      text: `- ${fact.key}: ${fact.value}`,
      kind: "fact",
    })),
    { text: "## Applicable lessons", kind: "heading" },
    ...lessons.map((lesson) => ({
      text: `- ${lesson.negative ? "AVOID: " : ""}${lesson.rule} [${
        lesson.category
      }]`,
      kind: "lesson",
    })),
  ];

  const body: string[] = [];
  let factsIncluded = 0;
  let lessonsIncluded = 0;
  let truncated = false;

  for (const candidate of candidates) {
    const complete = [OPEN, ...body, candidate.text, CLOSE].join("\n");
    if (bytes(complete) > maxBytes) {
      truncated = true;
      break;
    }
    body.push(candidate.text);
    if (candidate.kind === "fact") factsIncluded += 1;
    if (candidate.kind === "lesson") lessonsIncluded += 1;
  }

  if (truncated) {
    while (
      body.length > 0 &&
      bytes([OPEN, ...body, TRUNCATED, CLOSE].join("\n")) > maxBytes
    ) {
      const removed = body.pop()!;
      if (removed.startsWith("- ")) {
        if (removed.includes(" [") && lessonsIncluded > 0) lessonsIncluded -= 1;
        else if (factsIncluded > 0) factsIncluded -= 1;
      }
    }
    if (bytes([OPEN, ...body, TRUNCATED, CLOSE].join("\n")) <= maxBytes)
      body.push(TRUNCATED);
  }

  return {
    text: [OPEN, ...body, CLOSE].join("\n"),
    details: {
      facts: factsIncluded,
      lessons: lessonsIncluded,
      truncated,
      project,
    },
  };
}

export function hasMemoryInjection(ctx: ExtensionContext): boolean {
  return ctx.sessionManager
    .getBranch()
    .some(
      (entry) =>
        entry.type === "custom_message" &&
        entry.customType === MEMORY_CUSTOM_TYPE
    );
}

export function injectMemoryOnce(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  store: MemoryStore
) {
  if (hasMemoryInjection(ctx))
    return { injected: false, reason: "already-present" } as const;
  const built = buildMemoryInjection(store, canonicalProject(ctx.cwd));
  if (!built.text) return { injected: false, reason: "empty" } as const;
  pi.sendMessage(
    {
      customType: MEMORY_CUSTOM_TYPE,
      content: built.text,
      display: false,
      details: built.details,
    },
    { triggerTurn: false }
  );
  return { injected: true, ...built.details } as const;
}
