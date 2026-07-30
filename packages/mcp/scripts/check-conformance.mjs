#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const requiredScenarios = {
  "test/mcp-integration.test.ts": [
    "real stdio initializes, lists, calls, and terminates children on refresh and close",
    "real legacy SSE initializes, lists, calls, closes, and auto-falls back only from unsupported HTTP",
    "real Streamable HTTP initializes, lists, calls all result forms, refreshes, and closes",
    "real SDK advertises and completes sampling plus form-only elicitation handlers",
    "AbortSignal cancels a slow protocol tool call",
    "discovery pagination stops on repeated cursors, enforces metadata caps, and observes cancellation",
    "unexpected close marks only the live connection disconnected and the next operation reconnects",
    "list-change storms coalesce, preserve metadata on failure, and stop safely at shutdown",
    "close coordinates with an in-flight connection and leaves no connected state",
    "diagnostics are global or per-server, bounded, and redact configured values",
  ],
  "test/elicitation.test.ts": [
    "form elicitation rejects URL mode, unsafe or oversized schemas, and aborted work",
  ],
  "test/oauth-integration.test.ts": [
    "OAuth DCR/PKCE completes through the real gateway and stored tokens reconnect and refresh",
    "OAuth coordinator shutdown cleans an active attempt and is terminal",
  ],
  "test/apps.test.ts": [
    "official App and AppBridge complete a postMessage handshake and same-server tool call",
    "real SDK tool metadata and resources/read open an App while preserving the tool result",
    "controller close aborts in-flight App tool calls and removes all sessions",
  ],
  "test/publisher.test.ts": [
    "real controller publishes a private dashboard and complete App proxy through the gateway",
  ],
  "test/metadata-cache.test.ts": [
    "metadata cache supports cold/warm loads without storing configuration secrets and uses private modes",
    "a warm cache hydrates disconnected direct-tool metadata without network",
  ],
};

for (const [relative, scenarios] of Object.entries(requiredScenarios)) {
  const source = await readFile(join(root, relative), "utf8");
  for (const scenario of scenarios) {
    if (!source.includes(`test(\"${scenario}\"`)) {
      console.error(`Missing required conformance scenario: ${relative}: ${scenario}`);
      process.exit(1);
    }
  }
}

const tests = (await readdir(join(root, "test")))
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join("test", name));
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...tests], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NO_COLOR: "1" },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
