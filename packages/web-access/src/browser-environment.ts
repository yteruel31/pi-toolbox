import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";

export type BrowserFailureCode = "unsupported-os" | "bwrap-missing" | "browser-missing" | "browser-incompatible" | "namespace-denied" | "apparmor-denied" | "launch-unknown" | "render-unknown" | "parent-request" | "timeout" | "cancelled" | "probe-mismatch" | "cleanup-failed";
const messages: Record<BrowserFailureCode, string> = {
  "unsupported-os": "Isolated JavaScript rendering is supported on Linux only.",
  "bwrap-missing": "Bubblewrap (bwrap) is missing or not executable at the supported system paths.",
  "browser-missing": "No executable system Chromium/Chrome was found (or the explicit WEB_ACCESS_CHROMIUM_PATH is unavailable).",
  "browser-incompatible": "The selected browser is not a native ELF executable under /usr or /opt. Snap/Flatpak launchers and home-directory browsers are not supported.",
  "namespace-denied": "The actual isolated browser launch reported a namespace permission failure. Kernel policy, AppArmor or container restrictions may be responsible; this does not identify which one.",
  "apparmor-denied": "The actual isolated browser launch reported an AppArmor denial. Inspect matching kernel audit events before changing a profile.",
  "launch-unknown": "The isolated browser could not launch; the cause is unknown. Missing libraries, browser compatibility or security policy may be involved.",
  "render-unknown": "The browser launched but page rendering failed; the cause is unknown. This is not proof of a namespace or AppArmor failure.",
  "parent-request": "A parent-routed browser request failed (transport, URL policy or resource limit). This is not evidence that the sandbox failed to launch.",
  timeout: "Isolated rendering timed out.",
  cancelled: "Isolated rendering was cancelled.",
  "probe-mismatch": "The synthetic page did not produce the expected JavaScript DOM mutation through parent routing.",
  "cleanup-failed": "The browser operation ended but its temporary wrapper could not be removed. Inspect temporary web-access-browser-* directories only after confirming no render is running.",
};
export class BrowserFailure extends Error {
  constructor(readonly code: BrowserFailureCode) {
    super(`[${code}] ${messages[code]} HTTP-only fetch remains available with render: \"never\"; it does not execute JavaScript. Open /web-access → Diagnostic for checks and manual remedies. No unsandboxed fallback.`);
    this.name = "BrowserFailure";
  }
}
/** Classify launch output only; never retain raw stderr, paths, environment or Error.cause. */
export function classifyBrowserLaunch(error: unknown): BrowserFailure {
  const text = error instanceof Error ? error.message.slice(0, 65536) : "";
  if (/apparmor[^\n]*(?:denied|DENIED)|apparmor="DENIED"/i.test(text)) return new BrowserFailure("apparmor-denied");
  if (/bwrap:.*(?:creating new namespace failed|setting up uid map|unshare).*?(?:not permitted|permission denied)|failed to move to new namespace.*(?:not permitted|permission denied)|failed to unshare.*(?:not permitted|permission denied)/is.test(text)) return new BrowserFailure("namespace-denied");
  return new BrowserFailure("launch-unknown");
}

export interface BrowserHost {
  platform: string;
  arch: string;
  browserPath?: string;
  read: (path: string) => Promise<string | undefined>;
  executable: (path: string) => Promise<boolean>;
  nativeBrowser: (path: string) => Promise<string | undefined>;
}
/** Fixed local files only, bounded reads; never execute a discovered browser during inspection. */
async function readLocal(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try { const buffer = Buffer.alloc(65536); const { bytesRead } = await file.read(buffer); return buffer.subarray(0, bytesRead).toString("utf8"); }
    finally { await file.close(); }
  } catch { return undefined; }
}
export const systemBrowserHost = (): BrowserHost => ({
  platform: process.platform, arch: process.arch, browserPath: process.env.WEB_ACCESS_CHROMIUM_PATH,
  read: readLocal,
  executable: async (path) => { try { await access(path, constants.X_OK); return true; } catch { return false; } },
  nativeBrowser: async (path) => {
    try {
      const resolved = await realpath(path);
      if (!resolved.startsWith("/usr/") && !resolved.startsWith("/opt/")) return undefined;
      const file = await open(resolved, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) return undefined;
        const bytes = Buffer.alloc(4); await file.read(bytes);
        return bytes.equals(Buffer.from([127, 69, 76, 70])) ? resolved : undefined;
      }
      finally { await file.close(); }
    } catch { return undefined; }
  },
});
export interface BrowserRuntime { bwrap?: string; chromium?: string; failure?: BrowserFailureCode }
export async function inspectBrowserRuntime(host = systemBrowserHost()): Promise<BrowserRuntime> {
  if (host.platform !== "linux") return { failure: "unsupported-os" };
  let bwrap: string | undefined;
  for (const path of ["/usr/bin/bwrap", "/bin/bwrap"]) if (await host.executable(path)) { bwrap = path; break; }
  let chromium: string | undefined, incompatible = false;
  const candidates = host.browserPath !== undefined ? [host.browserPath] : ["/usr/lib/chromium/chromium", "/usr/lib64/chromium-browser/chromium-browser", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/opt/google/chrome/chrome"];
  for (const path of candidates) {
    if (!await host.executable(path)) continue;
    chromium = await host.nativeBrowser(path);
    if (chromium) break;
    incompatible = true;
  }
  return { bwrap, chromium, failure: !bwrap ? "bwrap-missing" : !chromium ? incompatible ? "browser-incompatible" : "browser-missing" : undefined };
}
