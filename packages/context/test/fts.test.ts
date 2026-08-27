import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import { compileFtsQuery, FTS_MAX_TERM_LENGTH, probeFts5 } from "../src/storage/fts.js";

describe("FTS foundation", () => {
  it("probes real FTS5 and always removes its temporary table", () => {
    const db = new DatabaseSync(":memory:");
    expect(probeFts5(db)).toEqual({ available: true });
    expect(db.prepare("SELECT name FROM sqlite_temp_master WHERE name = ?").get("context_fts5_capability_probe")).toBeUndefined();
    db.close();
  });

  it("reports injected unavailability and attempts cleanup", () => {
    const exec = vi.fn((sql: string) => { if (sql.startsWith("CREATE")) throw new Error("no fts5"); });
    expect(probeFts5({ exec })).toMatchObject({ available: false, diagnostic: expect.stringContaining("no fts5") });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("compiles bounded literal-only Unicode terms", () => {
    expect(compileFtsQuery('alpha OR beta* "quoted" - NOT café 東京 _ok')).toBe('"alpha" OR "OR" OR "beta" OR "quoted" OR "NOT" OR "café" OR "東京" OR "_ok"');
    expect(compileFtsQuery("*** -- \"\"")).toBeUndefined();
    const query = compileFtsQuery(Array.from({ length: 20 }, (_, i) => `t${i}`).join(" "))!;
    expect(query.split(" OR ")).toHaveLength(16);
    expect(compileFtsQuery("x".repeat(100))).toBe(`"${"x".repeat(FTS_MAX_TERM_LENGTH)}"`);
  });
});
