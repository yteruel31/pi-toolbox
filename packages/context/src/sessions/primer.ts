import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { SessionIndex } from "./index.js";
import {
  SESSION_PRIMER_CUSTOM_TYPE,
  SESSION_PRIMER_MAX_BYTES,
  type IndexedSession,
} from "./schema.js";

const OPEN = "<recent-sessions>";
const CLOSE = "</recent-sessions>";
const MARKER = "- … (truncated)";
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

function clean(text: string, maxCodepoints: number): string {
  return Array.from(text.replace(/[\r\n]+/g, " "))
    .slice(0, maxCodepoints)
    .join("");
}

function orderedSessions(
  index: SessionIndex,
  project: string
): IndexedSession[] {
  const projectSessions = index.list({ project, limit: 5 });
  const recentSessions = index.list({ limit: 5 });
  const seen = new Set<string>();
  return [...projectSessions, ...recentSessions].filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

export function buildSessionPrimer(
  index: SessionIndex,
  project: string,
  maxBytes = SESSION_PRIMER_MAX_BYTES
) {
  // Primer search is intentionally omitted while synchronization is active or
  // when FTS5 is unavailable, so startup never races the derived index.
  if (!index.hasFts5 || index.isSyncing || index.size() === 0) {
    return { text: "", count: 0, truncated: false };
  }

  const body: string[] = [];
  let truncated = false;
  for (const session of orderedSessions(index, project)) {
    const title = clean(session.title || session.summary || session.id, 160);
    const line = `- ${session.createdAt.slice(0, 10)} | ${title} | id: ${session.id}`;
    const complete = [OPEN, ...body, line, CLOSE].join("\n");
    if (bytes(complete) <= maxBytes) {
      body.push(line);
      continue;
    }
    truncated = true;
    break;
  }

  if (!body.length) return { text: "", count: 0, truncated };
  if (truncated) {
    while (
      body.length > 0 &&
      bytes([OPEN, ...body, MARKER, CLOSE].join("\n")) > maxBytes
    ) {
      body.pop();
    }
    if (bytes([OPEN, ...body, MARKER, CLOSE].join("\n")) <= maxBytes) {
      body.push(MARKER);
    }
  }
  const text = [OPEN, ...body, CLOSE].join("\n");
  return {
    text: bytes(text) <= maxBytes ? text : "",
    count: body.filter((line) => line !== MARKER).length,
    truncated,
  };
}

export function injectSessionPrimerOnce(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  index: SessionIndex
) {
  const alreadyPresent = ctx.sessionManager
    .getBranch()
    .some(
      (entry: any) =>
        (entry.type === "custom_message" ||
          (entry.type === "message" && entry.message?.role === "custom")) &&
        (entry.customType === SESSION_PRIMER_CUSTOM_TYPE ||
          entry.message?.customType === SESSION_PRIMER_CUSTOM_TYPE)
    );
  if (alreadyPresent) {
    return { injected: false, reason: "already-present" } as const;
  }
  const built = buildSessionPrimer(index, ctx.cwd);
  if (!built.text) {
    return { injected: false, reason: "unavailable" } as const;
  }
  pi.sendMessage(
    {
      customType: SESSION_PRIMER_CUSTOM_TYPE,
      content: built.text,
      display: false,
      details: {
        sessionCount: built.count,
        truncated: built.truncated,
      },
    },
    { triggerTurn: false }
  );
  return { injected: true, ...built } as const;
}
