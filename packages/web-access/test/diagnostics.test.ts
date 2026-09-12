import assert from "node:assert/strict";
import test from "node:test";
import fs, { access, readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import type { Browser } from "playwright-core";
import { BrowserFailure, classifyBrowserLaunch, inspectBrowserRuntime, type BrowserHost } from "../src/browser-environment.js";
import { renderPage, type BrowserDependencies } from "../src/browser.js";
import { inspectWebAccess, testIsolatedRendering } from "../src/diagnostics.js";

function host(options: { platform?: string; arch?: string; browserPath?: string; binaries?: string[]; wrappers?: string[]; files?: Record<string, string> } = {}): BrowserHost {
  return { platform: options.platform ?? "linux", arch: options.arch ?? "x64", browserPath: options.browserPath,
    executable: async (path) => (options.binaries ?? []).includes(path),
    nativeBrowser: async (path) => (options.wrappers ?? []).includes(path) ? undefined : path,
    read: async (path) => options.files?.[path] };
}
const binaries = ["/usr/bin/bwrap", "/opt/google/chrome/chrome", "/usr/sbin/apparmor_parser"];
const summary = (report: unknown) => JSON.stringify(report);
test("runtime distinguishes unsupported OS, missing bwrap/browser, wrappers and explicit override without fallback", async () => {
  for (const platform of ["darwin", "win32"]) {
    const h = host({ platform }); h.executable = async () => { throw new Error("Must not inspect Linux paths"); };
    assert.equal((await inspectBrowserRuntime(h)).failure, "unsupported-os");
    assert.doesNotMatch(summary(await inspectWebAccess(h)), /sudo apt/);
  }
  assert.equal((await inspectBrowserRuntime(host())).failure, "bwrap-missing");
  assert.equal((await inspectBrowserRuntime(host({ binaries: [binaries[0]!] }))).failure, "browser-missing");
  assert.equal((await inspectBrowserRuntime(host({ binaries, browserPath: "/private-secret" }))).failure, "browser-missing");
  assert.equal((await inspectBrowserRuntime(host({ binaries: [binaries[0]!, "/usr/bin/chromium"], wrappers: ["/usr/bin/chromium"] }))).failure, "browser-incompatible");
  assert.equal((await inspectBrowserRuntime(host({ binaries }))).failure, undefined);
});
test("opening checks make no success claim and emit only exact distro/architecture remedies", async () => {
  const ubuntu = await inspectWebAccess(host({ files: { "/etc/os-release": 'ID=ubuntu\nVERSION_ID="26.04"' } }));
  assert.match(summary(ubuntu), /google-chrome-stable_current_amd64.deb/);
  assert.match(summary(ubuntu), /No HTTP request made/);
  assert.match(summary(ubuntu), /NOT tested/);
  assert.equal(ubuntu.checks[0]?.state, "untested");
  const debian = await inspectWebAccess(host({ files: { "/etc/os-release": "ID=debian" } }));
  assert.match(summary(debian), /apt-get install chromium/);
  assert.doesNotMatch(summary(debian), /google-chrome-stable/);
  for (const files of [{ "/etc/os-release": "ID=fedora\nID_LIKE=debian" }, {}] as Record<string, string>[]) assert.doesNotMatch(summary(await inspectWebAccess(host({ files }))), /sudo apt|sudo dnf/);
  assert.doesNotMatch(summary(await inspectWebAccess(host({ arch: "arm64", files: { "/etc/os-release": "ID=ubuntu" } }))), /amd64.deb/);
  assert.doesNotMatch(summary(await inspectWebAccess(host({ browserPath: "/secret-token", files: { "/etc/os-release": "ID=\u001bsecret" } }))), /secret-token|\u001b/);
});
test("namespace and AppArmor hints are not launch verdicts; recent recipe gated on exact layout", async () => {
  const files = { "/etc/os-release": 'ID=ubuntu\nVERSION_ID="26.04"', "/proc/sys/kernel/unprivileged_userns_clone": "1", "/proc/sys/user/max_user_namespaces": "56952", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1", "/sys/module/apparmor/parameters/enabled": "Y",
    "/etc/apparmor.d/bwrap-userns-restrict": "abi <abi/5.0>,\nprofile bwrap /usr/bin/bwrap {\n allow pix /** -> &bwrap//&unpriv_bwrap,\n include if exists <local/bwrap-userns-restrict>\n}",
    "/etc/apparmor.d/chrome": "abi <abi/5.0>,\nprofile chrome /opt/google/chrome/chrome flags=(unconfined) {\n userns,\n}", "/sys/kernel/security/apparmor/features/domain/stack": "yes\n",
    "/etc/apparmor.d/local/bwrap-userns-restrict": "priority=100 allow px /opt/google/chrome/chrome -> &bwrap//&chrome,\n" };
  const report = await inspectWebAccess(host({ binaries, files }));
  assert.match(summary(report), /present on disk/); assert.match(summary(report), /Do not append it again/);
  assert.match(summary(report), /loaded policy are NOT verified/);
  assert.match(summary(report), /apparmor_parser -Q -T/);
  assert.doesNotMatch(summary(report), /sysctl -w|aa-disable|--no-sandbox.*fallback/);
  const older = await inspectWebAccess(host({ binaries, files: { ...files, "/etc/os-release": "ID=ubuntu\nVERSION_ID=24.04" } }));
  assert.doesNotMatch(summary(older), /sudoedit|priority=100/);
  for (const [path, token] of [["/etc/apparmor.d/bwrap-userns-restrict", "abi "], ["/etc/apparmor.d/bwrap-userns-restrict", "profile bwrap"], ["/etc/apparmor.d/bwrap-userns-restrict", "allow pix"], ["/etc/apparmor.d/bwrap-userns-restrict", "include if exists"], ["/etc/apparmor.d/chrome", "profile chrome"], ["/etc/apparmor.d/chrome", "userns,"]] as const) {
    const report = await inspectWebAccess(host({ binaries, files: { ...files, [path]: files[path].replace(token, `# ${token}`) } }));
    assert.doesNotMatch(summary(report), /sudoedit|priority=100/, `${path}: ${token}`);
    assert.match(summary(report), /Compatibility.*not established/);
  }
  const blocked = await inspectWebAccess(host({ binaries, files: { "/proc/sys/user/max_user_namespaces": "0" } }));
  assert.equal(blocked.checks.find((c) => c.label.startsWith("User namespaces"))?.state, "warning");
  assert.match(summary(blocked), /unprivileged_userns_clone=unknown/);
});
test("launch errors are classified conservatively and raw diagnostics/causes never escape", () => {
  for (const [raw, code] of [
    ["bwrap: Creating new namespace failed: Operation not permitted", "namespace-denied"],
    ["Failed to move to new namespace: errno = Operation not permitted", "namespace-denied"],
    ['apparmor="DENIED" capability sys_admin', "apparmor-denied"],
    ["Operation not permitted", "launch-unknown"],
    ["No usable sandbox!", "launch-unknown"],
    ["missing libfoo.so", "launch-unknown"],
  ]) {
    const failure = classifyBrowserLaunch(new Error(`${raw}\nprivate-token=https://secret.test`));
    assert.equal(failure.code, code); assert.equal(failure.cause, undefined);
    assert.doesNotMatch(failure.stack!, /private-token|secret.test/);
    assert.match(failure.message, /render: "never"/);
  }
});

test("synthetic probe verifies routing AND DOM execution, never accepts unchanged HTML or arbitrary errors", async () => {
  let calls = 0;
  const passed = await testIsolatedRendering(undefined, async (url, options) => {
    assert.equal(options.timeoutMs, 10_000); assert.equal(url, "https://web-access-diagnostic.invalid/");
    const response = await options.request(url); calls++;
    const marker = JSON.parse(response.body.toString().match(/textContent=("[^"]+")/)![1]!);
    return `<html><body><p id="probe">${marker}</p></body></html>`;
  });
  assert.equal(passed.state, "passed"); assert.equal(calls, 1); assert.match(passed.summary, /No DNS\/HTTP/);
  const inert = await testIsolatedRendering(undefined, async (url, opts) => (await opts.request(url)).body.toString());
  assert.equal(inert.state, "failed"); assert.match(inert.summary, /probe-mismatch/);
  const noRoute = await testIsolatedRendering(undefined, async () => "fake"); assert.equal(noRoute.state, "failed");
  const unknown = await testIsolatedRendering(undefined, async () => { throw new Error("private-secret"); });
  assert.doesNotMatch(unknown.summary, /private-secret/);
  const controller = new AbortController(); controller.abort();
  assert.equal((await testIsolatedRendering(controller.signal)).state, "cancelled");
});

function engineHarness(options: { launchFailure?: string; lateLaunch?: Promise<void>; pageFailure?: boolean; requestFailure?: boolean; phase?: "context" | "routes" | "evaluate"; onPhase?: () => void } = {}) {
  let wrapper = "", closed = 0, contextClosed = 0;
  let routeHandler: any;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const wait = async (phase: typeof options.phase) => { if (options.phase === phase) { options.onPhase?.(); await gate; } };
  const browser = {
    close: async () => { closed++; release(); },
    newContext: async () => { await wait("context"); return ({
      close: async () => { contextClosed++; }, routeWebSocket: async () => {},
      route: async (_pattern: string, handler: any) => { await wait("routes"); routeHandler = handler; }, on: () => {},
      newPage: async () => ({ on: () => {}, goto: async () => {
        if (options.pageFailure) throw new Error('apparmor="DENIED" private-page-spoof');
        if (options.requestFailure) await routeHandler({ request: () => ({ method: () => "GET", url: () => "https://example.test/", headers: () => ({}) }), abort: async () => {} });
      }, evaluate: async () => { await wait("evaluate"); return "<html>rendered</html>" } }),
    }); },
  } as unknown as Browser;
  const deps: BrowserDependencies = {
    inspect: async () => ({ bwrap: binaries[0], chromium: binaries[1] }),
    loadEngine: async () => ({ launch: async (launch) => {
      wrapper = launch!.executablePath!;
      assert.match(await readFile(wrapper, "utf8"), /--unshare-net/);
      assert.equal(launch!.chromiumSandbox, true);
      assert.equal(launch!.env?.SECRET_TOKEN, undefined);
      if (options.lateLaunch) await options.lateLaunch;
      if (options.launchFailure) throw new Error(options.launchFailure);
      return browser;
    } }),
  };
  return { deps, wrapper: () => wrapper, closed: () => closed, contextClosed: () => contextClosed };
}
const renderOptions = { timeoutMs: 1000, request: async () => { throw new Error("private-network-token"); } };
test("cancellation during context, routing or evaluation joins outstanding work and cleans every resource", async () => {
  for (const phase of ["context", "routes", "evaluate"] as const) {
    const controller = new AbortController();
    const h = engineHarness({ phase, onPhase: () => controller.abort() });
    await assert.rejects(renderPage("https://example.test/", { ...renderOptions, signal: controller.signal }, h.deps), (error: BrowserFailure) => error.code === "cancelled");
    assert.ok(h.closed() > 0); assert.ok(h.contextClosed() > 0);
    await assert.rejects(access(dirname(h.wrapper())));
  }
});
test("cleanup errors are sanitized and never converted to success or hidden by cancellation", async () => {
  const original = fs.rm;
  const h = engineHarness();
  fs.rm = async () => { throw new Error("private-filesystem-path"); }; syncBuiltinESMExports();
  try {
    await assert.rejects(renderPage("https://example.test/", renderOptions, h.deps), (e: BrowserFailure) => e.code === "cleanup-failed" && !e.message.includes("private-filesystem"));
  } finally { fs.rm = original; syncBuiltinESMExports(); await fs.rm(dirname(h.wrapper()), { recursive: true, force: true }); }
  const controller = new AbortController(); controller.abort();
  const result = await testIsolatedRendering(controller.signal, async () => { throw new BrowserFailure("cleanup-failed"); });
  assert.equal(result.state, "failed"); assert.match(result.summary, /cleanup-failed/);
});
test("production renderer cleanup on success, launch error, page error and parent failure; no false AppArmor certainty", async () => {
  for (const [options, code] of [[{}, undefined], [{ launchFailure: "bwrap: Creating new namespace failed: Operation not permitted" }, "namespace-denied"], [{ pageFailure: true }, "render-unknown"], [{ requestFailure: true }, "parent-request"]] as const) {
    const h = engineHarness(options);
    const promise = renderPage("https://example.test/", renderOptions, h.deps);
    if (code) await assert.rejects(promise, (e: BrowserFailure) => e.code === code && !e.message.includes("private"));
    else assert.match(await promise, /rendered/);
    await assert.rejects(access(dirname(h.wrapper())));
    if (!options.launchFailure) assert.ok(h.closed() > 0);
  }
});
test("cancellation and timeout join late launch and close browser before removing wrapper / settling", async () => {
  for (const cancel of [true, false]) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const h = engineHarness({ lateLaunch: gate });
    const controller = new AbortController(); let settled = false;
    const result = renderPage("https://example.test/", { ...renderOptions, timeoutMs: cancel ? 1000 : 20, signal: controller.signal }, h.deps);
    const checked = assert.rejects(result, (error: BrowserFailure) => error.code === (cancel ? "cancelled" : "timeout")).then(() => { settled = true; });
    while (!h.wrapper()) await new Promise((resolve) => setTimeout(resolve, 1));
    if (cancel) controller.abort(new Error("private-cancel-reason"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false); await access(h.wrapper());
    release(); await checked;
    assert.ok(h.closed() > 0); await assert.rejects(access(dirname(h.wrapper())));
  }
});
