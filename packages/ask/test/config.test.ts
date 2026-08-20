import test from "node:test";
import assert from "node:assert/strict";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { agentDirectory, ConfigStore, DEFAULT_CONFIG, parseConfig, validateKeymaps, type FileAdapter } from "../src/config.ts";

test("config root delegates to Pi's official agent directory", () => {
  assert.equal(agentDirectory(), getAgentDir());
});

test("migrates supported partial config in memory", () => {
  const parsed = parseConfig({ schemaVersion: 2, behavior: { showFooterHints: false }, notifications: false });
  assert.equal(parsed.migrated, true);
  assert.equal(parsed.config.schemaVersion, 5);
  assert.equal(parsed.config.behaviour.showFooterHints, false);
  assert.equal(parsed.config.notifications.enabled, false);
  assert.deepEqual(parsed.config.keymaps, DEFAULT_CONFIG.keymaps);
});

test("future versions fail closed to defaults", () => {
  const parsed = parseConfig({ schemaVersion: 99 });
  assert.match(parsed.invalid!, /unsupported/);
  assert.deepEqual(parsed.config, DEFAULT_CONFIG);
});

test("invalid keymaps fall back without dropping valid behavior", () => {
  const input: any = structuredClone(DEFAULT_CONFIG);
  input.behaviour.presentSingleAsMulti = true;
  input.keymaps = { global: {} };
  const parsed = parseConfig(input);
  assert.equal(parsed.config.behaviour.presentSingleAsMulti, true);
  assert.deepEqual(parsed.config.keymaps, DEFAULT_CONFIG.keymaps);
  assert.match(parsed.warning!, /default keymaps/);
});

test("keymaps reject fixed numeric and cross-context duplicates", () => {
  const numeric = structuredClone(DEFAULT_CONFIG.keymaps);
  numeric.main.confirm = ["1"];
  assert.equal(validateKeymaps(numeric).valid, false);
  const conflict = structuredClone(DEFAULT_CONFIG.keymaps);
  conflict.editor.submit = ["ctrl+c"];
  assert.equal(validateKeymaps(conflict).valid, false);
});

test("normalizes aliases in valid keymaps", () => {
  const keys = structuredClone(DEFAULT_CONFIG.keymaps);
  keys.main.cancel = ["escape"];
  keys.editor.submit = ["return"];
  keys.editor.nextTabWhenEmpty = ["ctrl+pageup"];
  const result = validateKeymaps(keys);
  assert.equal(result.valid, true);
  assert.deepEqual(result.keymaps.main.cancel, ["esc"]);
  assert.deepEqual(result.keymaps.editor.submit, ["enter"]);
  assert.deepEqual(result.keymaps.editor.nextTabWhenEmpty, ["ctrl+pageUp"]);
});

class MemoryFiles implements FileAdapter {
  values = new Map<string, string>();
  failWrites = false;
  async read(path: string): Promise<string> {
    if (!this.values.has(path)) { const error = Object.assign(new Error("missing"), { code: "ENOENT" }); throw error; }
    return this.values.get(path)!;
  }
  async write(path: string, text: string): Promise<void> {
    if (this.failWrites) throw new Error("readonly");
    this.values.set(path, text);
  }
}

test("store loads a fallback non-destructively and writes only primary", async () => {
  const files = new MemoryFiles();
  files.values.set("/legacy.json", JSON.stringify({ schemaVersion: 1, behaviour: { showFooterHints: false } }));
  const store = new ConfigStore("/primary.json", ["/legacy.json"], files);
  await store.load();
  assert.equal(store.sourcePath, "/legacy.json");
  assert.equal(store.get().behaviour.showFooterHints, false);
  assert.equal(files.values.get("/legacy.json")?.includes('"schemaVersion":1'), true);
  const result = await store.update((config) => { config.behaviour.showFooterHints = true; });
  assert.equal(result.ok, true);
  assert.ok(files.values.has("/primary.json"));
});

test("concurrent updates serialize and compose from the latest persisted state", async () => {
  const files = new MemoryFiles();
  const store = new ConfigStore("/primary.json", [], files);
  await store.load();
  const first = store.update((config) => { config.behaviour.showFooterHints = false; });
  const second = store.update((config) => { config.notifications.enabled = false; });
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(store.get().behaviour.showFooterHints, false);
  assert.equal(store.get().notifications.enabled, false);
  const persisted = JSON.parse(files.values.get("/primary.json")!);
  assert.equal(persisted.behaviour.showFooterHints, false);
  assert.equal(persisted.notifications.enabled, false);
});

test("failed immediate save keeps the prior live state", async () => {
  const files = new MemoryFiles();
  const store = new ConfigStore("/primary.json", [], files);
  await store.load();
  const seen: boolean[] = [];
  store.subscribe((config) => seen.push(config.behaviour.showFooterHints));
  files.failWrites = true;
  const result = await store.update((config) => { config.behaviour.showFooterHints = false; });
  assert.equal(result.ok, false);
  assert.equal(store.get().behaviour.showFooterHints, true);
  assert.deepEqual(seen, []);
});

test("invalid current-schema fields fall back as one invalid file", () => {
  const input: any = structuredClone(DEFAULT_CONFIG);
  input.answer.extractionRetries = 9;
  const parsed = parseConfig(input);
  assert.match(parsed.invalid!, /extractionRetries/);
  assert.deepEqual(parsed.config, DEFAULT_CONFIG);
});

test("invalid JSON remains untouched", async () => {
  const files = new MemoryFiles();
  files.values.set("/primary.json", "{broken");
  const store = new ConfigStore("/primary.json", [], files);
  await store.load();
  assert.equal(files.values.get("/primary.json"), "{broken");
  assert.ok(store.notices.some((notice) => notice.kind === "error"));
});
