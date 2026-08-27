import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { KnowledgeIndex } from "./index.js";

export const KNOWLEDGE_OVERVIEW_CUSTOM_TYPE = "context.knowledge-overview";
export const KNOWLEDGE_OVERVIEW_MAX_BYTES = 6 * 1024;
const OPEN = "<knowledge-overview>";
const CLOSE = "</knowledge-overview>";
const MARKER = "- … (truncated)";
const stop = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "this",
  "that",
  "note",
  "notes",
  "intro",
  "readme",
]);
const tokens = (value: string) =>
  value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) =>
        word.length >= 3 &&
        word.length <= 30 &&
        !stop.has(word) &&
        !/^\d+$/.test(word)
    );

export function buildKnowledgeOverview(
  index: KnowledgeIndex,
  maxBytes = KNOWLEDGE_OVERVIEW_MAX_BYTES
) {
  if (index.size() === 0) return { text: "", fileCount: 0, truncated: false };
  const files = index.listFiles();
  const groups = new Map<string, typeof files>();
  for (const file of files) {
    const folder =
      path.dirname(file.relativePath) === "."
        ? "(root)"
        : path.dirname(file.relativePath).split(path.sep).slice(0, 2).join("/");
    groups.set(`${file.root}\0${folder}`, [
      ...(groups.get(`${file.root}\0${folder}`) ?? []),
      file,
    ]);
  }
  const rows = [...groups]
    .map(([key, grouped]) => {
      const [root, folder] = key.split("\0");
      const frequencies = new Map<string, number>();
      for (const file of grouped)
        for (const word of [
          ...tokens(
            path.basename(file.relativePath, path.extname(file.relativePath))
          ),
          ...file.headings.slice(0, 8).flatMap(tokens),
        ])
          frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
      const keywords = [...frequencies]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "en"))
        .slice(0, 6)
        .map(([word]) => word);
      return { root: root!, folder: folder!, count: grouped.length, keywords };
    })
    .sort(
      (a, b) =>
        a.root.localeCompare(b.root, "en") ||
        b.count - a.count ||
        a.folder.localeCompare(b.folder, "en")
    );
  const lines = [
    OPEN,
    `Local knowledge: ${files.length} indexed file${
      files.length === 1 ? "" : "s"
    }. Use knowledge_search for topics and kb_read for a known note.`,
  ];
  let truncated = false;
  for (const row of rows) {
    const line = `- ${row.root} :: ${row.folder}/ (${row.count})${
      row.keywords.length ? ` — ${row.keywords.join(", ")}` : ""
    }`;
    if (Buffer.byteLength([...lines, line, CLOSE].join("\n")) > maxBytes) {
      truncated = true;
      break;
    }
    lines.push(line);
  }
  if (truncated) {
    while (
      lines.length > 2 &&
      Buffer.byteLength([...lines, MARKER, CLOSE].join("\n")) > maxBytes
    )
      lines.pop();
    if (Buffer.byteLength([...lines, MARKER, CLOSE].join("\n")) <= maxBytes)
      lines.push(MARKER);
  }
  lines.push(CLOSE);
  return {
    text:
      Buffer.byteLength(lines.join("\n")) <= maxBytes ? lines.join("\n") : "",
    fileCount: files.length,
    truncated,
  };
}

export function injectKnowledgeOverviewOnce(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  index: KnowledgeIndex,
  syncing = false
) {
  const present = ctx.sessionManager
    .getBranch()
    .some(
      (entry: any) =>
        entry.customType === KNOWLEDGE_OVERVIEW_CUSTOM_TYPE ||
        entry.message?.customType === KNOWLEDGE_OVERVIEW_CUSTOM_TYPE
    );
  if (present) return { injected: false, reason: "already-present" } as const;
  if (syncing) return { injected: false, reason: "syncing" } as const;
  const overview = buildKnowledgeOverview(index);
  if (!overview.text) return { injected: false, reason: "empty" } as const;
  pi.sendMessage(
    {
      customType: KNOWLEDGE_OVERVIEW_CUSTOM_TYPE,
      content: overview.text,
      display: false,
      details: { fileCount: overview.fileCount, truncated: overview.truncated },
    },
    { triggerTurn: false }
  );
  return { injected: true, ...overview } as const;
}
