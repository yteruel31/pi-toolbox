import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { discoverSessionFiles } from "../src/sessions/discovery.js";
import { parseSessionFile } from "../src/sessions/parser.js";
import { SESSION_MAX_INDEX_CHARS } from "../src/sessions/schema.js";

const line = (value: unknown) => `${JSON.stringify(value)}\n`;

describe("session JSONL parser", () => {
  it("extracts visible text and summaries while ignoring custom, images, tools, and malformed tails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-parser-"));
    const file = path.join(root, "session.jsonl");
    await writeFile(file,
      line({ type: "session", id: "abc", timestamp: "2025-01-01T00:00:00Z", cwd: "/work/demo" }) +
      line({ type: "message", timestamp: "2025-01-01T00:01:00Z", message: { role: "user", content: [{ type: "text", text: "find punctuation: hello!" }, { type: "image", data: "secret-image" }] } }) +
      line({ type: "message", timestamp: "2025-01-01T00:02:00Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }, { type: "toolCall", arguments: { token: "secret" } }] } }) +
      line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "secret-tool-output" }] } }) +
      line({ type: "custom_message", display: false, content: "hidden primer secret" }) +
      line({ type: "compaction", timestamp: "2025-01-01T00:03:00Z", summary: "compact result" }) + "{partial");
    const parsed = await parseSessionFile(file);
    expect(parsed).toMatchObject({ id: "abc", project: "demo", title: "find punctuation: hello!", summary: "compact result" });
    expect(parsed?.indexText).toContain("answer");
    expect(parsed?.indexText).not.toMatch(/secret|image|tool-output|primer/);
  });

  it("bounds output and yields to the event loop for a multi-megabyte file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-parser-large-"));
    const file = path.join(root, "large.jsonl");
    const message = line({ type: "message", timestamp: "2025-01-01T00:00:01Z", message: { role: "assistant", content: "x".repeat(10_000) } });
    await writeFile(file, line({ type: "session", id: "large", timestamp: "2025-01-01T00:00:00Z", cwd: root }) + message.repeat(600));
    let heartbeat = false;
    setImmediate(() => { heartbeat = true; });
    const parsed = await parseSessionFile(file);
    expect(heartbeat).toBe(true);
    expect(parsed!.indexText.length).toBeLessThanOrEqual(SESSION_MAX_INDEX_CHARS);
  });
});

describe("session discovery", () => {
  it("is deterministic, recursive, archive-aware, and does not follow symlinks", async () => {
    const agent = await mkdtemp(path.join(os.tmpdir(), "context-discovery-"));
    await mkdir(path.join(agent, "sessions", "project", "child"), { recursive: true });
    await mkdir(path.join(agent, "sessions-archive"), { recursive: true });
    await writeFile(path.join(agent, "sessions", "project", "z.jsonl"), "x");
    await writeFile(path.join(agent, "sessions", "project", "child", "a.jsonl"), "x");
    await writeFile(path.join(agent, "sessions-archive", "old.jsonl"), "x");
    await symlink(path.join(agent, "sessions-archive"), path.join(agent, "sessions", "linked"));
    const found = await discoverSessionFiles(agent);
    expect(found.map((x) => path.basename(x.path))).toEqual(["a.jsonl", "z.jsonl", "old.jsonl"]);
    expect(found.map((x) => x.archived)).toEqual([false, false, true]);
    expect((await discoverSessionFiles(agent, { maxFiles: 1 }))).toHaveLength(1);
    expect((await discoverSessionFiles(agent, { maxDepth: 0 }))).toHaveLength(1);
  });
});
