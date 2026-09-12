import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import webAccess from "../src/index.js";
import { registerSetupCommand } from "../src/setup-command.js";
import { SetupPanel } from "../src/tui/setup-panel.js";

async function fixture(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "web-setup-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try { await run(dir); } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}
function harness(act: (panel: SetupPanel) => void = (panel) => panel.handleInput("\x1b")) {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const messages: string[] = [];
  let customCalls = 0;
  const pi = { registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => commands.set(name, command), on: () => {} } as unknown as ExtensionAPI;
  const ctx = {
    mode: "tui", hasUI: true,
    ui: {
      notify: (text: string) => messages.push(text),
      custom: async (factory: (...args: unknown[]) => SetupPanel, options: { overlay?: boolean }) => {
        customCalls++;
        assert.equal(options.overlay, true);
        return new Promise<boolean>((done) => {
          const panel = factory({ terminal: { rows: 28 }, requestRender: () => {} }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text }, { matches: (data: string, id: string) => matchesKey(data, ({ "tui.select.confirm": "enter", "tui.select.cancel": "escape", "tui.select.down": "down", "tui.select.up": "up" } as Record<string, string>)[id] as never) }, done);
          panel.render(72); act(panel);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  registerSetupCommand(pi);
  return { pi, ctx, commands, messages, customCalls: () => customCalls, run: (args: string) => commands.get("web-access")!.handler(args, ctx) };
}

test("setup command is registered by the factory independently of tool enablement", () => {
  const h = harness(); h.commands.clear(); webAccess(h.pi);
  assert.deepEqual([...h.commands.keys()], ["web-access"]);
  assert.deepEqual(h.commands.get("web-access")!.getArgumentCompletions!("c"), [{ value: "config", label: "config" }]);
});

test("all command aliases open a cancellable modal without files or transcript messages", () => fixture(async (dir) => {
  const h = harness();
  for (const args of ["", "setup", "config"]) await h.run(args);
  assert.equal(h.customCalls(), 3);
  assert.deepEqual(await readdir(dir), []); assert.deepEqual(h.messages, []);
}));

test("unsupported modes and accidental credential arguments are never echoed", () => fixture(async (dir) => {
  const h = harness();
  await h.run("setup private-fixture");
  await h.commands.get("web-access")!.handler("setup", { ...h.ctx, mode: "rpc" });
  assert.equal(h.customCalls(), 0);
  assert.match(h.messages.join("\n"), /masked setup/);
  assert.match(h.messages.join("\n"), /interactive terminal UI/);
  assert.doesNotMatch(h.messages.join("\n"), /private-fixture/);
  assert.deepEqual(await readdir(dir), []);
}));

test("confirmed setup persists only private config and credential files, never the secret in notifications", () => fixture(async (dir) => {
  const h = harness((panel) => {
    for (let i = 0; i < 5; i++) panel.handleInput("\x1b[B"); // Storage field.
    panel.handleInput("\r"); panel.handleInput("\x1b[B"); panel.handleInput("\r"); // Apply file storage.
    panel.handleInput("\x1b[B"); panel.handleInput("\r"); // Edit key.
    panel.handleInput("\x1b[200~fixture-private-key\x1b[201~"); panel.handleInput("\r");
    panel.handleInput("\x1b[B"); panel.handleInput("\r"); panel.handleInput("\r"); // Review, then save.
  });
  await h.run("setup");
  assert.match(h.messages.join("\n"), /saved.*\/reload/);
  assert.doesNotMatch(h.messages.join("\n"), /fixture-private-key/);
  const raw = await readFile(join(dir, "web-access.json"), "utf8");
  assert.doesNotMatch(raw, /fixture-private-key/);
  assert.equal(JSON.parse(raw).credentials.gemini, "file:pi-web-access/gemini");
  assert.deepEqual((await readdir(dir)).sort(), ["web-access.credentials.json", "web-access.json"]);
}));

test("malformed setup config produces only sanitized diagnostics and no modal", () => fixture(async (dir) => {
  await writeFile(join(dir, "web-access.json"), '{"credentials":"private-fixture"', { mode: 0o600 });
  const h = harness(); await h.run("config");
  assert.equal(h.customCalls(), 0);
  assert.match(h.messages[0]!, /Cannot read web-access/); assert.doesNotMatch(h.messages[0]!, /private-fixture/);
}));
