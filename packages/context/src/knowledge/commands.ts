import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { contextPaths } from "../config/paths.js";
import {
  DEFAULT_KNOWLEDGE_CONFIG,
  type ContextConfig,
} from "../config/schema.js";
import { writeContextConfig } from "../config/write.js";
import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import {
  KnowledgeIndexService,
  KnowledgeSyncService,
} from "../runtime/services.js";
import { buildKnowledgeOverview } from "./overview.js";
import type { KnowledgeSyncResult } from "./schema.js";

const split = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

type SetupArgs = {
  roots?: string[];
  extensions?: string[];
  excludes?: string[];
};

export function parseKnowledgeSetupArgs(args: string): SetupArgs {
  const text = args.trim();
  if (!text) return {};
  const allowed = new Set(["roots", "extensions", "excludes"]);

  if (text.startsWith("{")) {
    const value: unknown = JSON.parse(text);
    if (value === null || Array.isArray(value) || typeof value !== "object") {
      throw new Error("Setup JSON must be an object");
    }
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowed.has(key))) {
      throw new Error("Setup accepts only roots, extensions, and excludes");
    }
    for (const key of allowed) {
      const field = record[key];
      if (
        field !== undefined &&
        (!Array.isArray(field) ||
          !field.every((item) => typeof item === "string"))
      ) {
        throw new Error(`${key} must be a string array`);
      }
    }
    return record as SetupArgs;
  }

  if (!text.startsWith("--")) return { roots: split(text) };
  const result: SetupArgs = {};
  const pattern = /--([\w-]+)\s+("[^"]*"|'[^']*'|\S+)/gy;
  let offset = 0;
  while (offset < text.length) {
    pattern.lastIndex = offset;
    const match = pattern.exec(text);
    if (!match || !allowed.has(match[1]!)) {
      throw new Error("Setup accepts only roots, extensions, and excludes");
    }
    result[match[1] as keyof SetupArgs] = split(
      match[2]!.replace(/^['"]|['"]$/g, "")
    );
    offset = pattern.lastIndex;
    while (text[offset] === " ") offset++;
  }
  return result;
}

async function canonicalRoots(
  roots: readonly string[],
  maximum: number
): Promise<string[]> {
  if (!roots.length || roots.length > maximum)
    throw new Error(`Specify 1 to ${maximum} roots`);
  const output: string[] = [];
  for (const root of roots) {
    const expanded = path.resolve(
      root === "~"
        ? os.homedir()
        : root.startsWith("~/")
        ? path.join(os.homedir(), root.slice(2))
        : root
    );
    const info = await lstat(expanded);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Knowledge root is not a regular directory: ${root}`);
    const uid = process.getuid?.();
    if (uid !== undefined && uid !== 0 && info.uid !== uid)
      throw new Error(
        `Knowledge root is not owned by the current user: ${root}`
      );
    output.push(await realpath(expanded));
  }
  return [...new Set(output)].sort((a, b) => a.localeCompare(b, "en"));
}
const summary = (result: KnowledgeSyncResult) =>
  `+${result.added} ~${result.updated} -${result.removed}; ${result.unchanged} unchanged`;

export function registerKnowledgeCommands(
  pi: ExtensionAPI,
  controller: ContextRuntimeController,
  options: { agentDir?: string } = {}
): void {
  pi.registerCommand("knowledge-search-setup", {
    description: "Configure FTS-only knowledge roots, extensions, and excludes",
    handler: async (args, ctx) => {
      try {
        const parsed = parseKnowledgeSetupArgs(args);
        const current = controller.currentHandle?.config;
        let roots = parsed.roots;
        if (!roots && ctx.hasUI !== false) {
          const answer = await ctx.ui.input(
            "Directories to index (comma-separated):",
            "~/notes"
          );
          if (!answer) {
            ctx.ui.notify("Setup cancelled.", "info");
            return;
          }
          roots = split(answer);
        }
        if (!roots) {
          ctx.ui.notify(
            "Provide roots as arguments or run setup in an interactive UI.",
            "warning"
          );
          return;
        }
        let extensions = parsed.extensions;
        if (!extensions && ctx.hasUI !== false)
          extensions = split(
            (await ctx.ui.input(
              "File extensions to index:",
              (
                current?.knowledge.extensions ??
                DEFAULT_KNOWLEDGE_CONFIG.extensions
              ).join(",")
            )) || "md,mdx,txt"
          );
        let excludes = parsed.excludes;
        if (!excludes && ctx.hasUI !== false)
          excludes = split(
            (await ctx.ui.input(
              "Directory names or paths to exclude:",
              (
                current?.knowledge.excludes ?? DEFAULT_KNOWLEDGE_CONFIG.excludes
              ).join(",")
            )) || "node_modules,.git"
          );
        const limits =
          current?.knowledge.limits ?? DEFAULT_KNOWLEDGE_CONFIG.limits;
        const config: ContextConfig = {
          version: 1,
          models: current?.models ?? {},
          knowledge: {
            roots: await canonicalRoots(roots, limits.maxRoots),
            extensions: (
              extensions ??
              current?.knowledge.extensions ??
              DEFAULT_KNOWLEDGE_CONFIG.extensions
            )
              .map((item) => item.replace(/^\./, "").toLowerCase())
              .filter(Boolean),
            excludes:
              excludes ??
              current?.knowledge.excludes ??
              DEFAULT_KNOWLEDGE_CONFIG.excludes,
            limits,
          },
        };
        await writeContextConfig(contextPaths(options.agentDir).config, config);
        ctx.ui.notify("Knowledge FTS configuration saved; reloading.", "info");
        await ctx.reload();
        return;
      } catch (error) {
        ctx.ui.notify(
          `Knowledge setup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error"
        );
      }
    },
  });
  pi.registerCommand("knowledge-overview", {
    description: "Show the bounded local knowledge overview",
    handler: async (_args, ctx) => {
      const handle = controller.currentHandle;
      if (!handle) {
        ctx.ui.notify("Knowledge index is not ready yet.", "warning");
        return;
      }
      try {
        const built = await handle.run(
          Effect.flatMap(KnowledgeSyncService, (sync) =>
            sync.status().state === "syncing"
              ? Effect.succeed({ text: "" })
              : Effect.map(KnowledgeIndexService, buildKnowledgeOverview)
          )
        );
        ctx.ui.notify(
          built.text ||
            "Knowledge overview is empty; configure roots and complete indexing first.",
          built.text ? "info" : "warning"
        );
      } catch {
        ctx.ui.notify(
          "Knowledge overview is unavailable; the rest of context remains active.",
          "error"
        );
      }
    },
  });
  pi.registerCommand("knowledge-reindex", {
    description: "Force a safe full rebuild of the local knowledge FTS index",
    handler: async (_args, ctx) => {
      const handle = controller.currentHandle;
      if (!handle) {
        ctx.ui.notify("Knowledge index is not ready yet.", "warning");
        return;
      }
      ctx.ui.setStatus("context-knowledge", "Re-indexing knowledge…");
      try {
        const result = await handle.run(
          Effect.flatMap(KnowledgeSyncService, (sync) =>
            Effect.promise(sync.reindex)
          )
        );
        const count = await handle.run(
          Effect.map(KnowledgeIndexService, (index) => index.size())
        );
        ctx.ui.notify(
          `Re-indexed knowledge: ${summary(result)} (${count} total)`,
          "info"
        );
      } catch {
        ctx.ui.notify(
          "Knowledge re-index failed; the existing index remains available.",
          "error"
        );
      } finally {
        ctx.ui.setStatus("context-knowledge", undefined);
      }
    },
  });
}
