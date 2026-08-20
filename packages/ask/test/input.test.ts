import test from "node:test";
import assert from "node:assert/strict";
import { ConfigStore, DEFAULT_CONFIG, parseConfig } from "../src/config.ts";
import { normalizeAsk } from "../src/contracts.ts";
import { RemoteAskRegistry } from "../src/remote.ts";
import { AskComponent, resolveConfiguredAction, showAskFlow } from "../src/surface.ts";

const literalMatch = (data: string, key: string) => data === key;

test("global keymaps take precedence in flow and editor contexts", () => {
  assert.equal(resolveConfiguredAction("ctrl+c", "main", DEFAULT_CONFIG, literalMatch), "dismiss");
  assert.equal(resolveConfiguredAction("?", "editor", DEFAULT_CONFIG, literalMatch), "settings");
  assert.equal(resolveConfiguredAction("enter", "editor", DEFAULT_CONFIG, literalMatch), "submit");
  assert.equal(resolveConfiguredAction("enter", "noteEditor", DEFAULT_CONFIG, literalMatch), "save");
});

test("main and settings navigation resolve configurable aliases", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.keymaps.main.nextTab = ["l"];
  config.keymaps.settingsModal.nextOption = ["j", "down"];
  assert.equal(resolveConfiguredAction("l", "main", config, literalMatch), "nextTab");
  assert.equal(resolveConfiguredAction("j", "settingsModal", config, literalMatch), "nextOption");
});

test("fixed numeric shortcuts cannot be shadowed by persisted keymaps", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.keymaps.main.confirm = ["1"];
  const parsed = parseConfig(config);
  assert.deepEqual(parsed.config.keymaps.main.confirm, ["enter"]);
});

function component() {
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] }).form!;
  const tui = { requestRender() {} } as any;
  const theme = new Proxy({}, { get: () => (_color: string, text: string) => text }) as any;
  const store = new ConfigStore("/unused/config.json", [], { read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }, write: async () => {} });
  const values: any[] = [];
  const instance = new AskComponent(tui, theme, form, process.cwd(), store, (value) => values.push(value), () => {});
  return { instance, values };
}

test("shift arrows scroll without moving the selected option", () => {
  const { instance } = component();
  instance.handleInput("\x1b[1;2B");
  assert.equal((instance as any).scrollOffset, 1);
  assert.equal(instance.state.cursor, 0);
  instance.handleInput("\x1b[1;2A");
  assert.equal((instance as any).scrollOffset, 0);
  assert.equal(instance.state.cursor, 0);
  instance.dispose();
});

test("editor submission obeys package bindings and built-in submit is disabled", () => {
  const { instance } = component();
  instance.state.cursor = 1;
  instance.handleInput("\r");
  const editor = (instance as any).editor;
  assert.equal(editor.disableSubmit, true);
  assert.equal(editor.onSubmit, undefined);
  editor.setText("custom answer");
  const config = structuredClone(DEFAULT_CONFIG);
  config.keymaps.editor.submit = ["ctrl+s"];
  (instance as any).config = config;
  instance.handleInput("\r");
  assert.equal((instance as any).mode, "custom");
  assert.equal(instance.state.answers.get("q")?.customText, undefined);
  instance.handleInput("\x13");
  assert.equal((instance as any).mode, "main");
  assert.equal(instance.state.answers.get("q")?.customText, "custom answer");
  instance.dispose();
});

test("configured editor close saves the current draft before returning to the flow", () => {
  const { instance } = component();
  instance.state.cursor = 1;
  instance.handleInput("\r");
  const editor = (instance as any).editor;
  editor.setText("saved on close");
  instance.handleInput("\x1b");
  assert.equal((instance as any).mode, "main");
  assert.equal(instance.state.answers.get("q")?.customText, "saved on close");
  instance.dispose();
});

test("autocomplete owns Enter and Esc before package editor actions", () => {
  const { instance } = component();
  instance.state.cursor = 1;
  instance.handleInput("\r");
  const editor = (instance as any).editor;
  const received: string[] = [];
  editor.isShowingAutocomplete = () => true;
  editor.handleInput = (data: string) => received.push(data);
  instance.handleInput("\r");
  instance.handleInput("\x1b");
  assert.deepEqual(received, ["\r", "\x1b"]);
  assert.equal((instance as any).mode, "custom");
  instance.dispose();
});

test("review numeric confirmation survives movement, changes shortcuts, and clears on leave", () => {
  const { instance } = component();
  instance.state.tab = instance.state.form.questions.length;
  instance.handleInput("1");
  assert.equal(instance.state.pendingReviewShortcut, 0);
  instance.handleInput("\x1b[B");
  assert.equal(instance.state.pendingReviewShortcut, 0);
  instance.handleInput("2");
  assert.equal(instance.state.pendingReviewShortcut, 1);
  instance.handleInput("\t");
  assert.equal(instance.state.pendingReviewShortcut, undefined);
  instance.dispose();
});

test("destructive type confirmation clears on notes and settings", () => {
  const { instance } = component();
  instance.state.pendingTypeChange = "q";
  instance.handleInput("n");
  assert.equal(instance.state.pendingTypeChange, undefined);
  instance.handleInput("\x1b");
  instance.state.pendingTypeChange = "q";
  instance.handleInput("?");
  assert.equal(instance.state.pendingTypeChange, undefined);
  instance.dispose();
});

test("first-use config creation failure notifies immediately with its path", async () => {
  const path = "/readonly/yteruel31-pi-ask.json";
  const store = new ConfigStore(path, [], {
    read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    write: async () => { throw new Error("readonly"); },
  });
  await store.load();
  (store as any).value.notifications.enabled = false;
  const notifications: string[] = [];
  const controller = new AbortController();
  controller.abort();
  const events = { on: () => () => {}, emit() {} };
  const remote = new RemoteAskRegistry(events);
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] }).form!;
  const theme = new Proxy({}, { get: (_target, property) => property === "bold" ? (text: string) => text : (_color: string, text: string) => text }) as any;
  const ctx: any = {
    cwd: process.cwd(),
    ui: {
      notify(message: string) { notifications.push(message); },
      custom(factory: any) {
        return new Promise((resolve) => factory({ requestRender() {} }, theme, {}, resolve));
      },
    },
  };
  await showAskFlow(ctx, form, store, { source: "tool", signal: controller.signal, remote });
  assert.ok(notifications.some((message) => message.includes(path)));
  remote.dispose();
});

test("throwing host UI disposes the component and completes the remote flow once", async () => {
  const store = new ConfigStore("/tmp/ask-config.json", [], {
    read: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
    write: async () => {},
  });
  await store.load();
  (store as any).value.notifications.enabled = false;
  const emitted: Array<[string, any]> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const events = {
    on(name: string, listener: (event: unknown) => void) { listeners.set(name, listener); return () => listeners.delete(name); },
    emit(name: string, event: unknown) { emitted.push([name, event]); listeners.get(name)?.(event); },
  };
  const remote = new RemoteAskRegistry(events);
  const form = normalizeAsk({ questions: [{ id: "q", prompt: "Q?", options: [{ value: "a", label: "A" }] }] }).form!;
  const theme = new Proxy({}, { get: (_target, property) => property === "bold" ? (text: string) => text : (_color: string, text: string) => text }) as any;
  const ctx: any = {
    cwd: process.cwd(),
    ui: {
      notify() {},
      custom(factory: any) {
        factory({ requestRender() {} }, theme, {}, () => {});
        throw new Error("host failed");
      },
    },
  };
  await assert.rejects(showAskFlow(ctx, form, store, { source: "tool", remote }), /host failed/);
  assert.equal((store as any).listeners.size, 0);
  assert.equal(emitted.filter(([name]) => name.endsWith(":completed")).length, 1);
  remote.dispose();
});
