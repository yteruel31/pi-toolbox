import { execFile } from "node:child_process";

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
