import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { requestJevConnection, type JevFetch } from "./jev-client.js";

export type JevCredentialSource = "environment" | "keyring" | "file";
export interface StoredJevConfig {
  version: 1;
  enabled: boolean;
  credential: { source: JevCredentialSource; value: string };
}

const MAX_BYTES = 64 * 1024;
const KEYRING_ARGS = ["application", "pi-subagents", "service", "jev"];

export function jevConfigPath(agentDir: string): string { return join(agentDir, "subagents-jev.json"); }
export function defaultJevCredentialPath(agentDir: string): string { return join(agentDir, "subagents-jev.credentials.json"); }
export function validJevKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
}

export async function readJevConfig(agentDir: string): Promise<StoredJevConfig | undefined> {
  const value = await safeJson(jevConfigPath(agentDir), false, true);
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean" || !isRecord(value.credential)) {
    throw new Error("Jev settings are invalid. Reopen /subagents Setup and save them again.");
  }
  const source = value.credential.source;
  const reference = value.credential.value;
  if (!["environment", "keyring", "file"].includes(String(source)) || typeof reference !== "string" || !reference) {
    throw new Error("Jev credential settings are invalid.");
  }
  return value as unknown as StoredJevConfig;
}

export async function resolveJevKey(config: StoredJevConfig, env = process.env, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (config.credential.source === "environment") {
    const key = env[config.credential.value];
    if (!validJevKey(key)) throw new Error("The configured Jev environment variable is missing or invalid.");
    return key;
  }
  if (config.credential.source === "keyring") return lookupKeyring(env, signal);
  const value = await safeJson(config.credential.value, true, false);
  const key = isRecord(value) ? value.jev : undefined;
  if (!validJevKey(key)) throw new Error("The private Jev credential file is missing a valid key.");
  return key;
}

export async function saveJevSetup(options: {
  agentDir: string;
  enabled: boolean;
  source: JevCredentialSource;
  reference?: string;
  key?: string;
  projectRoot?: string;
  storeKeyring?: typeof storeKeyring;
}): Promise<void> {
  const agentDir = resolve(options.agentDir);
  const reference = options.source === "environment"
    ? options.reference?.trim()
    : options.source === "file"
      ? resolve(options.reference?.trim() || defaultJevCredentialPath(agentDir))
      : "pi-subagents/jev";
  if (!reference || options.source === "environment" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) {
    throw new Error("Enter a valid environment variable name.");
  }
  if (options.source !== "environment" && !validJevKey(options.key)) throw new Error("Enter a valid Jev API key.");
  const config: StoredJevConfig = { version: 1, enabled: options.enabled, credential: { source: options.source, value: reference } };
  await ensureSafeDirectory(agentDir);
  const configTemp = await stage(jevConfigPath(agentDir), config);
  let credentialTemp: string | undefined;
  let credentialWritten = false;
  try {
    if (options.source === "file") {
      if (options.projectRoot && within(resolve(options.projectRoot), reference)) {
        throw new Error("The Jev credential file must be outside the repository.");
      }
      await ensureSafeDirectory(dirname(reference));
      credentialTemp = await stage(reference, { jev: options.key });
      await rename(credentialTemp, reference);
      credentialTemp = undefined;
      credentialWritten = true;
    } else if (options.source === "keyring") {
      await (options.storeKeyring ?? storeKeyring)(options.key!);
      credentialWritten = true;
    }
    await rename(configTemp, jevConfigPath(agentDir));
  } catch (error) {
    if (credentialWritten) throw new Error("Jev settings weren't saved, but the key may already be stored. Reopen Setup and review the selected storage.");
    throw error;
  } finally {
    await rm(configTemp, { force: true }).catch(() => undefined);
    if (credentialTemp) await rm(credentialTemp, { force: true }).catch(() => undefined);
  }
}

export async function testJevConnection(apiKey: string, fetchImpl: JevFetch = fetch, signal?: AbortSignal): Promise<void> {
  if (!validJevKey(apiKey)) throw new Error("Enter or resolve a valid Jev API key first.");
  try {
    await requestJevConnection({ apiKey, fetchImpl, signal });
  } catch {
    if (signal?.aborted) throw new Error("Jev connection test was cancelled.");
    throw new Error("Jev connection test failed.");
  }
}

async function storeKeyring(key: string): Promise<void> {
  if (process.platform !== "linux") throw new Error(keyringHelp());
  await secretTool(["store", "--label=Pi subagents Jev", ...KEYRING_ARGS], key);
}
async function lookupKeyring(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> {
  if (process.platform !== "linux") throw new Error(keyringHelp());
  const key = await secretTool(["lookup", ...KEYRING_ARGS], undefined, env, signal);
  if (!validJevKey(key)) throw new Error(keyringHelp());
  return key;
}
function secretTool(args: string[], stdin?: string, env = process.env, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("secret-tool", args, { env, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16_386, encoding: "utf8", shell: false }, (error, stdout) => {
      if (error) reject(new Error(keyringHelp())); else resolve(stdout.replace(/\r?\n$/, ""));
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
}
function keyringHelp(): string {
  return "Linux Secret Service failed. Install libsecret-tools, provide a session D-Bus, and unlock a Secret Service collection, or explicitly choose Private file. No insecure fallback was used.";
}
async function safeJson(path: string, privateMode: boolean, allowMissing: boolean): Promise<unknown> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw new Error("Cannot inspect Jev settings or credentials.");
  });
  if (!info) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES || process.platform !== "win32" && (info.uid !== process.getuid?.() || privateMode && (info.mode & 0o777) !== 0o600)) throw new Error("Jev settings or credentials must be safe regular files owned by you; credentials require mode 0600.");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { return JSON.parse(await file.readFile("utf8")); } catch { throw new Error("Jev settings or credentials contain invalid JSON."); } finally { await file.close(); }
}
async function ensureSafeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Refusing an unsafe Jev settings directory.");
}
async function stage(path: string, value: unknown): Promise<string> {
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.chmod(0o600); await file.writeFile(`${JSON.stringify(value, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
  return temporary;
}
function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || !value.startsWith("..") && !value.startsWith("/");
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
