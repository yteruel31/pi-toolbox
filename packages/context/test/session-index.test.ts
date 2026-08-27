import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { SessionIndex } from "../src/sessions/index.js";
import { sqliteResource } from "../src/storage/sqlite.js";

const header = (id: string, cwd: string, timestamp = "2025-01-01T00:00:00Z") =>
  `${JSON.stringify({ type: "session", id, cwd, timestamp })}\n`;
const user = (text: string, timestamp = "2025-01-01T00:01:00Z") =>
  `${JSON.stringify({ type: "message", timestamp, message: { role: "user", content: text } })}\n`;

async function fixture() {
  const agent = await mkdtemp(path.join(os.tmpdir(), "context-index-"));
  await mkdir(path.join(agent, "context"));
  await mkdir(path.join(agent, "sessions", "project"), { recursive: true });
  await mkdir(path.join(agent, "sessions-archive"));
  return agent;
}

describe("session SQLite index", () => {
  it("syncs add/update/delete and archive moves without reparsing unchanged fingerprints", async () => {
    const agent = await fixture();
    const active = path.join(agent, "sessions", "project", "one.jsonl");
    await writeFile(active, header("one-id", "/code/project") + user("alpha search"));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* sqliteResource(path.join(agent, "context", "sessions.db"));
      yield* Effect.promise(async () => {
        const parser = await import("../src/sessions/parser.js");
        const parse = vi.fn(parser.parseSessionFile);
        const index = new SessionIndex(db, { parse });
        expect(index.list()).toEqual([]);
        expect(await index.sync(agent)).toMatchObject({ added: 1 });
        expect(await index.sync(agent)).toMatchObject({ unchanged: 1 });
        expect(parse).toHaveBeenCalledTimes(1);
        const archived = path.join(agent, "sessions-archive", "one.jsonl");
        await rename(active, archived);
        expect(await index.sync(agent)).toMatchObject({ moved: 1 });
        expect(parse).toHaveBeenCalledTimes(1);
        await writeFile(archived, header("one-id", "/code/project") + user("beta updated content"));
        expect(await index.sync(agent)).toMatchObject({ updated: 1 });
        await rm(archived);
        expect(await index.sync(agent)).toMatchObject({ removed: 1 });
      });
    })));
  });

  it("lists, resolves deterministically, searches with FTS OR/BM25, and reports unavailable explicitly", async () => {
    const agent = await fixture();
    const dir = path.join(agent, "sessions", "project");
    await writeFile(path.join(dir, "a.jsonl"), header("abcdef-1", "/code/project", "2025-01-01T00:00:00Z") + user("sqlite punctuation!"));
    await writeFile(path.join(dir, "b.jsonl"), header("abcdef-2", "/code/other", "2025-02-01T00:00:00Z") + user("unrelated sqlite sqlite"));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* sqliteResource(path.join(agent, "context", "sessions.db"));
      yield* Effect.promise(async () => {
        const index = new SessionIndex(db);
        await index.sync(agent);
        expect(index.list({ project: "project" }).map((x) => x.id)).toEqual(["abcdef-1"]);
        expect(index.list({ after: "2025-01-15", before: "2025-03-01" }).map((x) => x.id)).toEqual(["abcdef-2"]);
        expect(index.resolve("abcdef").status).toBe("ambiguous");
        expect(index.resolve("abcdef-1").status).toBe("found");
        const search = index.search("sqlite!!! punctuation", 10);
        if (search.status === "available") expect(search.results[0]?.id).toBe("abcdef-1");
        const unavailable = new SessionIndex(db, { disableFts: true }).search("sqlite");
        expect(unavailable.status).toBe("unavailable");
      });
    })));
    expect((await stat(path.join(agent, "context"))).mode & 0o777).toBe(0o700);
  });

  it("keeps prior rows when a changed-file parser fails", async () => {
    const agent = await fixture();
    const file = path.join(agent, "sessions", "project", "one.jsonl");
    await writeFile(file, header("rollback", "/code/project") + user("before"));
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const db = yield* sqliteResource(path.join(agent, "context", "sessions.db"));
      yield* Effect.promise(async () => {
        const index = new SessionIndex(db);
        await index.sync(agent);
        await writeFile(file, header("rollback", "/code/project") + user("changed and longer"));
        const failing = new SessionIndex(db, { parse: async () => { throw new Error("parse failed"); } });
        await expect(failing.sync(agent)).rejects.toThrow("parse failed");
        expect(index.resolve("rollback")).toMatchObject({ status: "found", session: { title: "before" } });
      });
    })));
  });
});
