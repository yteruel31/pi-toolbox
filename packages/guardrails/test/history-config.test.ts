import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { ConfigStore } from "../src/config.js";
import { HistoryStore, filterHistory, relevantHistory } from "../src/history.js";
import { candidateView, safeCommand, sanitize } from "../src/sanitize.js";
import { candidate, config, entry, policy } from "./helpers.js";

test("config is global-authoritative; project policies only add enabled restrictions", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardrails-config-"));
  try {
    const store = new ConfigStore(join(root, "agent"), join(root, "project"));
    const initial = await store.load(true); assert.equal(initial.config.enabled, false);
    await store.save(config(), initial.revision);
    assert.equal((await stat(store.globalPath)).mode & 0o777, 0o600);
    await assert.rejects(store.save(config(), initial.revision));
    await mkdir(join(root, "project/.pi"), { recursive: true });
    for (const local of [{ version: 1, enabled: false, policies: [] }, { version: 1, policies: [policy({ action: "Allow" })] }, { version: 1, policies: [policy({ enabled: false })] }]) {
      await writeFile(store.projectPath, JSON.stringify(local)); assert.ok((await store.load(true)).error); assert.equal((await store.load(false)).error, undefined);
    }
    await writeFile(store.projectPath, JSON.stringify({ version: 1, policies: [policy({ action: "Deny" })] }));
    const merged = await store.load(true); assert.equal(merged.error, undefined); assert.equal(merged.policies.at(-1)?.source, "project");
    await writeFile(store.globalPath, "{broken"); assert.equal((await store.load(true)).config.enabled, true);
  } finally { await rm(root, { recursive: true }); }
});
test("history redacts credentials, escape sequences and file bodies before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardrails-history-"));
  const path = join(root, "private/history.sqlite");
  const store = new HistoryStore(path);
  try {
    store.put(entry({ summary: "\x1b]52;c;SECRET\x07 curl https://user:pass@example.org/?token=abc -H Bearer abc123", reason: "password=secret123 \x1b[2J hidden" }));
    const text = JSON.stringify(store.list());
    for (const forbidden of ["secret123", "abc123", "user:pass", "\u001b", "SECRET"]) assert.ok(!text.includes(forbidden), forbidden);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
    const c = candidate({ tool: "edit", args: { path: "a.ts", edits: [{ oldText: "TOP_SECRET", newText: "TOP_SECRET" }] } });
    assert.doesNotMatch(JSON.stringify(candidateView(c, "/project/a.ts", "edit")), /TOP_SECRET/);
    assert.doesNotMatch(safeCommand("cat <<EOF\nTOP_SECRET\nEOF"), /TOP_SECRET/);
    assert.doesNotMatch(safeCommand("TOKEN=topsecret curl -H 'Authorization: Bearer topsecret' https://host?token=topsecret"), /topsecret/);
    assert.doesNotMatch(sanitize("\u202eattack\x1b[31m"), /\u202e|\x1b/);
  } finally { store.close(); await rm(root, { recursive: true }); }
});
test("history has bounded retention, one-row updates, same-project evaluation references and independent UI filters", () => {
  const store = new HistoryStore(":memory:", 5);
  try {
    const now = Date.now();
    store.put(entry({ at: now - 31 * 86400000 })); assert.equal(store.list().length, 0);
    for (let i = 0; i < 10; i++) store.put(entry({ at: now + i })); assert.equal(store.list().length, 5);
    const latest = store.list()[0]; store.put({ ...latest, choice: "allow-once" }); assert.equal(store.list().length, 5);
    const other = entry({ project: "/another-project" });
    const worker = entry({ actor: { kind: "subagent", runId: "r", profile: "worker" } });
    const sameGlobal = entry({ sessionId: "another-session" });
    const events = [other, worker, sameGlobal, ...store.list()];
    assert.equal(filterHistory(events, { actor: "subagent", sessionId: "parent-1", search: "worker" }).length, 1);
    assert.equal(filterHistory(events, { decision: "human" }).length, 1);
    const references = relevantHistory(events, candidate(), "/project", "git status", []);
    assert.ok(!references.some((e) => e.id === other.id)); assert.ok(references.some((e) => e.id === worker.id)); assert.ok(references.some((e) => e.id === sameGlobal.id));
  } finally { store.close(); }
});
test("SQLite serializes cross-process writers without lost history entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardrails-concurrent-"));
  const path = join(root, "history.sqlite");
  const store = new HistoryStore(path);
  try {
    const insert = (entries: unknown[]) => new Promise<void>((resolve, reject) => {
      const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads'); const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(workerData.path); db.exec('PRAGMA busy_timeout=2000'); for(const e of workerData.entries) db.prepare('INSERT INTO events(id,at,payload) VALUES (?,?,?)').run(e.id,e.at,JSON.stringify(e)); db.close(); parentPort.postMessage('done');`, { eval: true, workerData: { path, entries } });
      worker.on("error", reject); worker.on("exit", (code) => code === 0 ? resolve() : reject(Error(String(code))));
    });
    await Promise.all(Array.from({ length: 4 }, () => insert(Array.from({ length: 25 }, () => entry()))));
    assert.equal(store.list().length, 100);
    // A second real store shares updates as well, including same-ID approval transitions.
    const other = new HistoryStore(path);
    try { const e = entry(); store.put(e); other.put({ ...e, choice: "deny", state: "denied" }); assert.equal(store.list().find((r) => r.id === e.id)?.state, "denied"); } finally { other.close(); }
  } finally { store.close(); await rm(root, { recursive: true }); }
});
