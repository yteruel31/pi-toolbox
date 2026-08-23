import path from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface ContextPaths {
  readonly root: string;
  readonly config: string;
  readonly memoryDb: string;
  readonly sessionsDb: string;
  readonly knowledgeDb: string;
}

/** Canonical fresh context paths under Pi's agent directory. This function performs no I/O. */
export function contextPaths(agentDir: string = getAgentDir()): ContextPaths {
  const root = path.join(agentDir, "context");
  return {
    root,
    config: path.join(root, "config.json"),
    memoryDb: path.join(root, "memory.db"),
    sessionsDb: path.join(root, "sessions.db"),
    knowledgeDb: path.join(root, "knowledge.db"),
  };
}
