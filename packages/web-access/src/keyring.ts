import { execFile } from "node:child_process";
import { validApiKey } from "./credentials.js";

export const KEYRING_SETUP_HELP = "Linux keyring storage failed. Install libsecret-tools, provide a session D-Bus and unlock a Secret Service collection (for example GNOME Keyring). Or go back and intentionally choose Private file. No automatic fallback was used. Settings are unchanged; if the helper failed after writing, the key may already be stored.";

/** The key travels over stdin, never argv, shell history, or diagnostics. */
export async function storeKeyring(provider: "gemini" | "openai" | "brave", key: string, env = process.env): Promise<void> {
  if (process.platform !== "linux" || !["gemini", "openai", "brave"].includes(provider) || !validApiKey(key)) throw new Error(KEYRING_SETUP_HELP);
  return new Promise((resolve, reject) => {
    const child = execFile("secret-tool", ["store", "--label=Pi web access", "application", "pi-web-access", "provider", provider], {
      env, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024, encoding: "utf8", shell: false,
    }, (error) => {
      if (error) reject(new Error(KEYRING_SETUP_HELP));
      else resolve();
    });
    child.stdin?.on("error", () => { /* execFile reports failure without exposing helper output */ });
    child.stdin?.end(key);
  });
}

/** Use Secret Service, not the kernel's non-persistent session keyring. */
export async function lookupKeyring(provider: "gemini" | "openai" | "brave", env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  if (process.platform !== "linux") throw new Error("Keyring credentials require Linux Secret Service and secret-tool");
  return new Promise((resolve, reject) => {
    const child = execFile("secret-tool", ["lookup", "application", "pi-web-access", "provider", provider], {
      env, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16_386, encoding: "utf8", shell: false,
    }, (error, stdout) => {
      // Never propagate helper errors: they can contain stdout, stderr or secrets.
      if (error) { reject(new Error("Linux keyring lookup failed; ensure secret-tool, a session D-Bus and an unlocked Secret Service collection are available")); return; }
      const key = stdout.replace(/\r?\n$/, "");
      if (!key || /[\s\x00-\x1f\x7f]/.test(key) || key.length > 16_384) {
        reject(new Error("Linux keyring entry is missing or invalid; store the provider API key with secret-tool")); return;
      }
      resolve(key);
    });
    child.stdin?.end();
  });
}
