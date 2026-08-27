import {
  mkdir,
  mkdtemp,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SessionIndex } from "../src/sessions/index.js";
import { readSession } from "../src/sessions/reader.js";

const header = (id: string) =>
  JSON.stringify({
    type: "session",
    id,
    cwd: "/project",
    timestamp: "2025-01-01T00:00:00Z",
  });
const message = (role: string, content: any, extra: any = {}) =>
  JSON.stringify({ type: "message", message: { role, content, ...extra } });

async function fixture() {
  const agent = await mkdtemp(path.join(os.tmpdir(), "context-reader-"));
  await mkdir(path.join(agent, "sessions"));
  await mkdir(path.join(agent, "sessions-archive"));
  const db = new DatabaseSync(":memory:");
  return {
    agent,
    db,
    index: new SessionIndex(db, { agentDir: agent }),
  };
}

describe("safe session reader", () => {
  it("paginates offsets, skips malformed/custom data, and controls tools", async () => {
    const value = await fixture();
    const file = path.join(value.agent, "sessions", "one.jsonl");
    await writeFile(
      file,
      [
        header("reader-id"),
        "bad-json",
        message("user", "one"),
        message("assistant", [
          { type: "text", text: "two" },
          { type: "toolCall", name: "bash", arguments: { secret: true } },
        ]),
        message("toolResult", "tool payload", { toolName: "bash" }),
        JSON.stringify({
          type: "message",
          customType: "context.memory",
          message: { role: "user", content: "hidden" },
        }),
        message("user", "three"),
      ].join("\n")
    );
    await value.index.sync();
    const first = await readSession(value.index, "reader", { limit: 2 });
    expect(first.text).toContain("one");
    expect(first.text).not.toContain("Tool call");
    expect(first.details).toMatchObject({ emitted: 2, nextOffset: 2 });
    const second = await readSession(value.index, "reader-id", {
      offset: 2,
      includeTools: true,
      limit: 2,
    });
    expect(second.text).toContain("tool payload");
    expect(second.text).not.toContain("hidden");
    expect((first.details.diagnostics as any).malformedLines).toBe(1);
    value.db.close();
  });

  it("rejects ambiguity, traversal, prefix collisions, and symlinks", async () => {
    const value = await fixture();
    await writeFile(
      path.join(value.agent, "sessions", "a.jsonl"),
      `${header("prefix-one")}\n${message("user", "a")}`
    );
    await writeFile(
      path.join(value.agent, "sessions", "b.jsonl"),
      `${header("prefix-two")}\n${message("user", "b")}`
    );
    const outside = path.join(value.agent, "outside.jsonl");
    await writeFile(outside, header("outside"));
    await symlink(outside, path.join(value.agent, "sessions", "link.jsonl"));
    await value.index.sync();
    expect((await readSession(value.index, "prefix")).status).toBe("ambiguous");
    expect((await readSession(value.index, outside)).status).toBe("denied");
    expect(
      (
        await readSession(
          value.index,
          path.join(value.agent, "sessions", "link.jsonl")
        )
      ).status
    ).not.toBe("ok");
    expect(
      (
        await readSession(
          value.index,
          path.join(value.agent, "sessions-other", "x.jsonl")
        )
      ).status
    ).not.toBe("ok");
    value.db.close();
  });

  it("drains pending reads before closing the handle on bounded pages", async () => {
    const value = await fixture();
    const file = path.join(value.agent, "sessions", "pending.jsonl");
    await writeFile(
      file,
      [
        header("pending-id"),
        ...Array.from({ length: 10_000 }, (_, index) =>
          message("user", `${index}:${"x".repeat(500)}`)
        ),
      ].join("\n")
    );
    await value.index.sync();

    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await readSession(value.index, "pending-id", {
        offset: 0,
        limit: 3,
        includeTools: false,
      });
      expect(result.details).toMatchObject({ emitted: 3, nextOffset: 3 });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    value.db.close();
  });

  it("closes the opened handle after natural EOF", async () => {
    const value = await fixture();
    const file = path.join(value.agent, "sessions", "eof.jsonl");
    await writeFile(
      file,
      `${header("eof-id")}\n${message("user", "complete")}`
    );
    await value.index.sync();

    const result = await readSession(value.index, "eof-id", { limit: 10 });
    expect(result.text).toContain("complete");
    expect(result.details).toMatchObject({ emitted: 1, truncated: false });
    expect(result.details.nextOffset).toBeUndefined();
    value.db.close();
  });

  it("streams the opened file handle when the pathname is swapped", async () => {
    const value = await fixture();
    const file = path.join(value.agent, "sessions", "swap.jsonl");
    const moved = path.join(value.agent, "sessions", "opened.jsonl");
    const rows = Array.from({ length: 5_000 }, (_, index) =>
      message("user", `approved-${index}`)
    );
    await writeFile(file, [header("swap-id"), ...rows].join("\n"));
    await value.index.sync();
    const reading = readSession(value.index, "swap-id", { limit: 100 });
    await new Promise((resolve) => setImmediate(resolve));
    await rename(file, moved);
    await writeFile(file, `${header("attacker")}\n${message("user", "redirected")}`);
    const result = await reading;
    expect(["ok", "not_found"]).toContain(result.status);
    if (result.status === "ok") {
      expect(result.text).toContain("approved-");
      expect(result.text).not.toContain("redirected");
    }
    value.db.close();
  });

  it("bounds output to 50KiB and 2000 lines with a continuation offset", async () => {
    const value = await fixture();
    const file = path.join(value.agent, "sessions", "large.jsonl");
    await writeFile(
      file,
      [
        header("large"),
        ...Array.from({ length: 2_100 }, (_, index) =>
          message("user", `${index}:${"x".repeat(100)}`)
        ),
      ].join("\n")
    );
    await value.index.sync();
    const result = await readSession(value.index, "large", { limit: 100 });
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
    expect(result.text.split("\n").length).toBeLessThanOrEqual(2_000);
    expect(result.details.nextOffset).toBeTypeOf("number");
    value.db.close();
  });
});
