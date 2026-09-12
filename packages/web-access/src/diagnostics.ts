import { randomUUID } from "node:crypto";
import { BrowserFailure, inspectBrowserRuntime, systemBrowserHost, type BrowserRuntime } from "./browser-environment.js";
import { renderPage } from "./browser.js";
import { loadConfig, type WebConfig } from "./config.js";
import { RedditService, type RedditDiagnostic } from "./reddit-service.js";

export interface DiagnosticCheck { label: string; state: "observed" | "warning" | "unavailable" | "untested"; summary: string }
export interface DiagnosticReport { checks: DiagnosticCheck[]; remedies: string[] }
export interface RedditDiagnosticResult { enabled: boolean; diagnostic: RedditDiagnostic }

/** Fresh shared-config Reddit inspection. Local files only; never launches a browser or network request. */
export async function inspectRedditAccess(): Promise<RedditDiagnosticResult> {
  const config = await loadConfig();
  return { enabled: config.enabled, diagnostic: await new RedditService(config).inspect() };
}

interface RedditDiagnosticDependencies {
  loadConfig(): Promise<WebConfig>;
  createService(config: WebConfig): Pick<RedditService, "inspect" | "test">;
}
const redditDependencies: RedditDiagnosticDependencies = { loadConfig, createService: (config) => new RedditService(config) };
/** Fresh shared-config explicit Reddit test. A disabled package never launches its browser. */
export async function testRedditAccess(signal?: AbortSignal, dependencies: RedditDiagnosticDependencies = redditDependencies): Promise<RedditDiagnosticResult> {
  const config = await dependencies.loadConfig();
  const service = dependencies.createService(config);
  if (!config.enabled) return { enabled: false, diagnostic: await service.inspect() };
  return { enabled: true, diagnostic: await service.test(signal) };
}
const value = (text?: string) => text?.trim().match(/^\d{1,12}$/)?.[0] ?? "unknown";
function osField(text: string | undefined, key: string): string | undefined {
  return text?.match(new RegExp(`^${key}=["']?([a-zA-Z0-9._-]+)["']?$`, "m"))?.[1];
}
/** Local metadata only: no subprocess, browser launch, DNS, HTTP, credentials or config writes. */
export async function inspectWebAccess(host = systemBrowserHost()): Promise<DiagnosticReport> {
  const runtime = await inspectBrowserRuntime(host);
  const checks: DiagnosticCheck[] = [
    { label: "Classic HTTP fetch", state: "untested", summary: "Independent of the optional browser. Use render: \"never\". No HTTP request made; connectivity, TLS and site access are NOT tested." },
    { label: "Optional JavaScript rendering", state: "untested", summary: "Not tested by local metadata checks. Executable presence and policy hints do not prove isolated rendering works." },
    { label: "Platform", state: host.platform === "linux" ? "observed" : "unavailable", summary: host.platform === "linux" ? "Linux; sandbox runtime supported in principle." : "Isolated rendering unsupported on this OS. Classic HTTP fetch is independent." },
  ];
  if (host.platform !== "linux") return { checks, remedies: ["Use render: \"never\" for HTTP-only extraction, or run Pi on a Linux host for isolated rendering. No macOS/Windows browser-install recipe applies."] };
  checks.push(
    { label: "Bubblewrap", state: runtime.bwrap ? "observed" : "unavailable", summary: runtime.bwrap ? "System bwrap executable found; not launched by this inspection." : "bwrap missing or not executable at /usr/bin/bwrap or /bin/bwrap." },
    { label: "System browser", state: runtime.chromium ? "observed" : "unavailable", summary: runtime.chromium ? "Native ELF under /usr or /opt found; version, shared libraries and runtime compatibility remain untested." : "No supported native executable found. Explicit WEB_ACCESS_CHROMIUM_PATH takes precedence; its value is not displayed. Snap/Flatpak/wrapper scripts are not supported." },
  );
  const paths = ["/etc/os-release", "/proc/sys/kernel/unprivileged_userns_clone", "/proc/sys/user/max_user_namespaces", "/proc/sys/kernel/apparmor_restrict_unprivileged_userns", "/sys/module/apparmor/parameters/enabled", "/etc/apparmor.d/bwrap-userns-restrict", "/etc/apparmor.d/chrome", "/sys/kernel/security/apparmor/features/domain/stack", "/etc/apparmor.d/local/bwrap-userns-restrict"];
  const [os, clone, max, restrict, enabled, bwrapProfile, chromeProfile, stack, local] = await Promise.all(paths.map((path) => host.read(path)));
  checks.push({ label: "User namespaces (hints)", state: value(clone) === "0" || value(max) === "0" ? "warning" : "observed", summary: `unprivileged_userns_clone=${value(clone)}; max_user_namespaces=${value(max)}. Missing/unreadable values are unknown, not a failure. Nonzero values do not prove nested namespaces work.` });
  checks.push({ label: "AppArmor (hints)", state: value(restrict) === "1" ? "warning" : "observed", summary: `enabled=${enabled?.trim() === "Y" ? "yes" : enabled?.trim() === "N" ? "no" : "unknown"}; apparmor_restrict_unprivileged_userns=${value(restrict)}. Restrictions alone do not prove that this bwrap/browser launch is blocked.` });
  const ubuntu = osField(os, "ID") === "ubuntu", debian = osField(os, "ID") === "debian";
  // Recognize only active declarations in the known packaged layout, never
  // commented examples/disabled includes. This is not an AppArmor parser.
  const activeBwrap = (bwrapProfile ?? "").replace(/#[^\n]*/g, "");
  const activeChrome = (chromeProfile ?? "").replace(/#[^\n]*/g, "");
  const recent = ubuntu && osField(os, "VERSION_ID") === "26.04"
    && await host.executable("/usr/sbin/apparmor_parser")
    && runtime.chromium === "/opt/google/chrome/chrome"
    && /^\s*abi <abi\/5\.0>,\s*$/m.test(activeBwrap)
    && /^\s*profile bwrap \/usr\/bin\/bwrap(?: flags=\([^\n)]*\))?\s*\{/m.test(activeBwrap)
    && /^\s*allow pix \/\*\* -> &bwrap\/\/&unpriv_bwrap,\s*$/m.test(activeBwrap)
    && /^\s*include if exists <local\/bwrap-userns-restrict>\s*$/m.test(activeBwrap)
    && /^\s*profile chrome \/opt\/google\/chrome\/chrome flags=\(unconfined\)\s*\{/m.test(activeChrome)
    && /^\s*abi <abi\/5\.0>,\s*$/m.test(activeChrome)
    && /^\s*userns,\s*$/m.test(activeChrome)
    && stack?.trim() === "yes";
  const exception = /^\s*priority=100 allow px \/opt\/google\/chrome\/chrome -> &bwrap\/\/&chrome,\s*$/m.test(local ?? "");
  checks.push({ label: "Targeted Ubuntu AppArmor recipe", state: recent ? "observed" : "untested", summary: recent
    ? `Ubuntu 26.04 / ABI 5.0 profile layout and kernel stacking detected. Local Chrome rule ${exception ? "present on disk" : "not detected"}. Parser priority support and loaded policy are NOT verified; the recipe is only a candidate until offline compilation and matching audit evidence.`
    : "Compatibility with the Ubuntu 26.04 stacked-profile recipe is not established. Do not copy that exception to this system blindly." });
  const remedies = installationRemedies(runtime, { ubuntu, debian, arch: host.arch });
  remedies.push("Read-only kernel settings (no sysctl executable needed): cat /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces /proc/sys/kernel/apparmor_restrict_unprivileged_userns ; absent files mean unknown",
    await host.executable("/usr/bin/journalctl") ? "After an explicit failed render, inspect matching audit events locally (may need administrator access): /usr/bin/journalctl -k --since '-5 minutes' --grep='apparmor=\"DENIED\"|unpriv_bwrap|chrome'" : "journalctl was not detected. Inspect matching kernel/audit events with your distribution's logging tools; administrator access may be required.",
    "An unrelated unshare probe is not authoritative. Keep global protections; ask the administrator to review matching namespace/container policy. Do not disable AppArmor or add --no-sandbox.");
  if (recent) remedies.push(
    "Ubuntu 26.04 candidate only: see README → Ubuntu 26.04 targeted AppArmor repair. First verify parser priority syntax offline; never infer a loaded policy from files.",
    "Offline parser check (no policy load): printf '%s\\n' 'abi <abi/5.0>,' 'profile web_access_priority_check { priority=100 allow px /opt/google/chrome/chrome -> &bwrap//&chrome, }' | /usr/sbin/apparmor_parser -Q -T",
    exception ? "The targeted rule already exists on disk. Do not append it again; run the explicit render test before considering any policy reload." : "Only after confirmed matching denial and successful offline check: sudoedit /etc/apparmor.d/local/bwrap-userns-restrict ; add exactly: priority=100 allow px /opt/google/chrome/chrome -> &bwrap//&chrome,",
    "After administrator-reviewed changes, compile the complete profile offline first: /usr/sbin/apparmor_parser -Q -T /etc/apparmor.d/bwrap-userns-restrict",
    "Only if compilation succeeds: sudo /usr/sbin/apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict ; then rerun the explicit test. This wizard never runs these commands.");
  return { checks, remedies };
}
function installationRemedies(runtime: BrowserRuntime, os: { ubuntu: boolean; debian: boolean; arch: string }): string[] {
  const lines: string[] = [];
  if (!runtime.bwrap) lines.push(os.ubuntu || os.debian ? "Debian/Ubuntu only, manual install: sudo apt-get update && sudo apt-get install bubblewrap" : "No verified package command for this distribution. Install native system bubblewrap using the distribution's documentation.");
  if (!runtime.chromium) {
    if (os.debian) lines.push("Debian native browser: sudo apt-get install chromium");
    else if (os.ubuntu && os.arch === "x64") lines.push("Ubuntu amd64: obtain Google's official stable .deb from https://www.google.com/chrome/ (review vendor terms). In the download directory: sudo apt-get install ./google-chrome-stable_current_amd64.deb ; expected binary /opt/google/chrome/chrome. Do not install Ubuntu's chromium-browser Snap launcher for this sandbox.");
    else lines.push("No verified browser installation command for this distribution/architecture. Use a native Chromium ELF under /usr or /opt, following vendor/distribution documentation; not Snap, Flatpak or a Playwright download.");
    lines.push("If explicitly configured, correct or unset WEB_ACCESS_CHROMIUM_PATH in Pi's launch environment, then restart Pi. It must name the actual system executable, not a launcher or home-directory symlink.");
  }
  return lines;
}
export interface RenderProbeResult { state: "passed" | "failed" | "cancelled"; summary: string }
/** No live network. Reuses production renderPage, launch plan, route handler and cleanup. */
export async function testIsolatedRendering(signal?: AbortSignal, render = renderPage): Promise<RenderProbeResult> {
  const url = "https://web-access-diagnostic.invalid/";
  const marker = randomUUID();
  let routed = 0;
  try {
    const html = await render(url, { timeoutMs: 10_000, signal, request: async (requested, options) => {
      options?.signal?.throwIfAborted();
      if (requested !== url) throw new BrowserFailure("parent-request");
      routed++;
      return { url, status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(`<!doctype html><html><body><p id="probe">pending</p><script>document.getElementById('probe').textContent=${JSON.stringify(marker)}</script></body></html>`) };
    } });
    if (signal?.aborted) throw new BrowserFailure("cancelled");
    if (!routed || !html.includes(`<p id="probe">${marker}</p>`)) throw new BrowserFailure("probe-mismatch");
    return { state: "passed", summary: "Isolated browser + parent routing + JavaScript DOM mutation passed on synthetic content. Browser and temporary wrapper cleaned up. No DNS/HTTP connectivity, external site or provider credentials were tested." };
  } catch (error) {
    const failure = error instanceof BrowserFailure && error.code === "cleanup-failed" ? error
      : signal?.aborted ? new BrowserFailure("cancelled") : error instanceof BrowserFailure ? error : new BrowserFailure("render-unknown");
    return { state: failure.code === "cancelled" ? "cancelled" : "failed", summary: failure.message };
  }
}
