import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("manifest exposes exactly one native Pi extension with required runtime dependencies", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    name: string;
    pi?: { extensions?: string[] };
    dependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    engines?: { node?: string };
  };
  assert.equal(manifest.name, "@yteruel31/pi-diagram");
  assert.deepEqual(manifest.pi?.extensions, ["./src/index.ts"]);
  assert.ok(manifest.dependencies?.["@dagrejs/dagre"]);
  assert.ok(manifest.dependencies?.["@resvg/resvg-js"]);
  assert.ok(manifest.dependencies?.["proper-lockfile"]);
  assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
  assert.equal(manifest.peerDependencies?.typebox, "*");
  assert.equal(manifest.engines?.node, ">=22.19.0");
});

test("packed package includes viewer assets and excludes tests", () => {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string; size: number }> }>;
  const files = report[0]?.files ?? [];
  const paths = files.map(({ path }) => path);
  for (const required of ["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "src/index.ts", "src/server/viewer-client.js", "src/server/viewer.css"]) {
    assert.ok(paths.includes(required), `package is missing ${required}`);
  }
  assert.equal(paths.some((path) => path === "test" || path.startsWith("test/")), false);
  assert.ok(files.reduce((sum, file) => sum + file.size, 0) < 250_000, "package source exceeds 250 KB unpacked");
});
