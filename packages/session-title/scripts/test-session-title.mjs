import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const tmpRoot = await mkdtemp(join(tmpdir(), "pi-session-title-"));
const buildDir = join(tmpRoot, "build");
const originalHostEnvironment = Object.fromEntries(
  ["HERDR_ENV", "HERDR_TAB_ID", "TMUX", "PATH", "PI_SESSION_TITLE_TEST_LOG"].map((key) => [key, process.env[key]]),
);
delete process.env.HERDR_ENV;
delete process.env.HERDR_TAB_ID;
delete process.env.TMUX;
delete process.env.PI_SESSION_TITLE_TEST_LOG;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitForLog(logPath, expected, timeout = 1_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const content = await readFile(logPath, "utf8");
      if (content.includes(expected)) return content;
    } catch {
      // The fake executable may not have created its log yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${logPath}`);
}

try {
  await symlink(join(repoRoot, "node_modules"), join(tmpRoot, "node_modules"), "dir");
  execFileSync(
    process.execPath,
    [
      join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(packageRoot, "tsconfig.json"),
      "--outDir",
      buildDir,
      "--noEmit",
      "false",
    ],
    { cwd: packageRoot, stdio: "inherit" },
  );

  const extension = await import(pathToFileURL(join(buildDir, "index.js")));

  assertEqual(extension.cleanPrompt("# Build `auth`\nnow"), "Build auth now", "prompt cleaning should normalize Markdown");
  assertEqual(extension.fallbackSummary("Je voudrais ajouter un système de notifications Twitch"), "ajouter système notifications…", "fallback titles should keep useful short keywords");
  assertEqual(extension.normalizeGeneratedTitle("Titre: Corriger les alertes !\nextra"), "Corriger les alertes", "generated titles should be normalized");
  assertEqual(extension.safeTitle("hello\u0007  world"), "hello world", "terminal control characters should be removed");

  const sessionFile = join(tmpRoot, "session.jsonl");
  await writeFile(sessionFile, [
    JSON.stringify({ type: "session", id: "fixture" }),
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
    "{ malformed fixture line",
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the login flow" }] } }),
  ].join("\n"));
  assertEqual(await extension.firstUserPromptFromSession(sessionFile), "Fix the login flow", "the first user prompt should survive malformed JSONL lines");
  assertEqual(await extension.firstUserPromptFromSession(join(tmpRoot, "missing.jsonl")), undefined, "missing session files should fail softly");

  const handlers = new Map();
  const commands = new Map();
  const sessionNames = [];
  let currentSessionName;
  const fakePi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, definition) { commands.set(name, definition); },
    getSessionName() { return currentSessionName; },
    setSessionName(name) { currentSessionName = name; sessionNames.push(name); },
  };
  extension.default(fakePi);

  assert(commands.has("rename"), "the extension should register /rename");
  assert(handlers.has("input"), "the extension should register raw input handling");
  assert(handlers.has("session_start"), "the extension should register session lifecycle handlers");

  const titles = [];
  const statuses = [];
  const notifications = [];
  const context = {
    mode: "tui",
    model: undefined,
    modelRegistry: {},
    ui: {
      theme: {
        fg(_color, text) { return text; },
        bold(text) { return text; },
      },
      setTitle(title) { titles.push(title); },
      setStatus(key, value) { statuses.push({ key, value }); },
      notify(message, level) { notifications.push({ message, level }); },
    },
    sessionManager: {
      getSessionFile() { return undefined; },
      getBranch() { return []; },
    },
  };

  await handlers.get("session_start")({ reason: "startup" }, context);
  assertEqual(titles.at(-1), "π nouvelle session", "new empty sessions should receive a temporary terminal title");

  await handlers.get("input")({ text: "Implement OAuth callback validation", source: "interactive" }, context);
  await handlers.get("before_agent_start")({ prompt: "Expanded skill body that must not replace the raw request" }, context);
  await new Promise((resolve) => setImmediate(resolve));
  assertEqual(sessionNames.at(-1), "π implement oauth callback…", "raw input should name the Pi session before prompt expansion");
  await handlers.get("session_info_changed")({ name: sessionNames.at(-1) }, context);
  assertEqual(titles.at(-1), sessionNames.at(-1), "the terminal title should stay synchronized through the session event");
  assertEqual(statuses.at(-1)?.key, "session-title", "the session title should use a stable status bar key");
  assertEqual(statuses.at(-1)?.value, `session ◀ ${sessionNames.at(-1)} ▶`, "the Pi status bar should display the current session name");

  const generatedNameCount = sessionNames.length;
  await handlers.get("before_agent_start")({ prompt: "A later prompt must not rename it" }, context);
  assertEqual(sessionNames.length, generatedNameCount, "later prompts should keep the authoritative existing session name");

  const recentContext = {
    ...context,
    sessionManager: {
      ...context.sessionManager,
      getBranch() {
        return [
          { type: "message", message: { role: "assistant", content: [{ type: "text", text: "oldcontext ".repeat(300) }] } },
          { type: "message", message: { role: "user", content: [{ type: "text", text: "NewestOAuth regression callback" }] } },
        ];
      },
    },
  };
  await commands.get("rename").handler("", recentContext);
  assert(sessionNames.at(-1).toLowerCase().includes("newestoauth"), "AI rename fallback should prioritize the newest conversation content");

  await commands.get("rename").handler("Manual title", context);
  assertEqual(sessionNames.at(-1), "Manual title", "manual rename should update the Pi session name");
  await handlers.get("session_info_changed")({ name: sessionNames.at(-1) }, context);
  assert(notifications.some(({ message }) => message.includes("Manual title")), "manual rename should notify the user");

  const titleCount = titles.length;
  const jsonContext = { ...context, mode: "json" };
  await commands.get("rename").handler("Headless title", jsonContext);
  await handlers.get("session_info_changed")({ name: sessionNames.at(-1) }, jsonContext);
  assertEqual(sessionNames.at(-1), "Headless title", "headless mode should still update session metadata");
  assertEqual(titles.length, titleCount, "headless mode should not write terminal title side effects");
  assertEqual(statuses.at(-1)?.value, "session ◀ Manual title ▶", "headless mode should not write status bar side effects");
  await handlers.get("session_shutdown")({ reason: "quit" }, context);

  const fakeBin = join(tmpRoot, "bin");
  const hostLog = join(tmpRoot, "host.log");
  const fakeHerdr = join(fakeBin, "herdr");
  await mkdir(fakeBin);
  await writeFile(fakeHerdr, `#!/bin/sh
if [ "$1" = "tab" ] && [ "$2" = "get" ]; then
  printf '%s\\n' '{"result":{"tab":{"number":7}}}'
  exit 0
fi
printf 'start:%s\\n' "$4" >> "$PI_SESSION_TITLE_TEST_LOG"
if [ "$4" = "Stale title" ]; then sleep 0.5; fi
printf 'done:%s\\n' "$4" >> "$PI_SESSION_TITLE_TEST_LOG"
`);
  await chmod(fakeHerdr, 0o755);
  process.env.PATH = `${fakeBin}:${originalHostEnvironment.PATH ?? ""}`;
  process.env.HERDR_ENV = "1";
  process.env.HERDR_TAB_ID = "fixture-tab";
  process.env.PI_SESSION_TITLE_TEST_LOG = hostLog;

  const hostHandlers = new Map();
  const hostPi = {
    on(name, handler) { hostHandlers.set(name, handler); },
    registerCommand() {},
    getSessionName() { return undefined; },
    setSessionName() {},
  };
  extension.default(hostPi);
  await hostHandlers.get("session_info_changed")({ name: "Host title" }, context);
  await waitForLog(hostLog, "done:Host title");
  await hostHandlers.get("session_info_changed")({ name: "Stale title" }, context);
  await waitForLog(hostLog, "start:Stale title");
  const shutdownStarted = Date.now();
  await hostHandlers.get("session_shutdown")({ reason: "new" }, context);
  assert(Date.now() - shutdownStarted < 400, "session shutdown should abort an in-flight host update promptly");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert(!(await readFile(hostLog, "utf8")).includes("done:Stale title"), "aborted host updates must not overwrite a newer session title");

  console.log("pi-session-title tests passed");
} finally {
  for (const [key, value] of Object.entries(originalHostEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tmpRoot, { recursive: true, force: true });
}
