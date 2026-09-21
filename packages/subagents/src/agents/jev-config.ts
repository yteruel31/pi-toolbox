import { execFile } from "node:child_process";
import { resolve, dirname, isAbsolute, join } from "node:path";
import { rename, rm } from "node:fs/promises";
import { requestJevConnection, type JevFetch } from "./jev-client.js";
import { acquireLock, ensureSafePath, JevStorageError, jevStorageErrorMessage, makeSafeDirectory, readSafeText, sameRevision, stagePrivate, type JevRevision } from "./jev-storage.js";

export { JevStorageError, jevStorageErrorMessage } from "./jev-storage.js";
export type JevCredentialSource = "environment" | "keyring" | "file";
export interface StoredJevConfig { version: 1; enabled: boolean; credential: { source: JevCredentialSource; value: string } }
export interface JevSetupSnapshot { config?: StoredJevConfig; revision?: JevRevision }
const KEYRING_ARGS = ["application", "pi-subagents", "service", "jev"];
const queues = new Map<string, Promise<unknown>>();
function queued<T>(path: string, action: () => Promise<T>): Promise<T> { const previous = queues.get(path) ?? Promise.resolve(); const next = previous.catch(() => undefined).then(action); queues.set(path, next); return next.finally(() => { if (queues.get(path) === next) queues.delete(path); }); }
export function jevConfigPath(agentDir: string): string { return join(agentDir, "subagents-jev.json"); }
export function defaultJevCredentialPath(agentDir: string): string { return join(agentDir, "subagents-jev.credentials.json"); }
export function validJevKey(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value); }
function validReference(source: JevCredentialSource, value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && (source === "environment" ? /^[A-Za-z_][A-Za-z0-9_]{0,255}$/.test(value) : source === "keyring" ? value === "pi-subagents/jev" : value.length > 0 && isAbsolute(value));
}
function parseConfig(value: unknown): StoredJevConfig {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean" || !isRecord(value.credential) || !["environment", "keyring", "file"].includes(String(value.credential.source))) throw new JevStorageError("invalid");
  const source = value.credential.source as JevCredentialSource;
  if (!validReference(source, value.credential.value)) throw new JevStorageError("invalid");
  return value as unknown as StoredJevConfig;
}
export async function readJevSetupSnapshot(agentDir: string): Promise<JevSetupSnapshot> {
  try { const result = await readSafeText(jevConfigPath(resolve(agentDir)), false, true); return { config: result.text === undefined ? undefined : parseConfig(JSON.parse(result.text)), revision: result.revision }; }
  catch (error) { if (error instanceof JevStorageError) throw error; throw new JevStorageError("read"); }
}
export async function readJevConfig(agentDir: string): Promise<StoredJevConfig | undefined> { return (await readJevSetupSnapshot(agentDir)).config; }
export async function resolveJevKey(config: StoredJevConfig, env = process.env, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted(); parseConfig(config);
  if (config.credential.source === "environment") { const key = env[config.credential.value]; if (!validJevKey(key)) throw new JevStorageError("invalid"); return key; }
  if (config.credential.source === "keyring") return lookupKeyring(env, signal);
  try { const result = await readSafeText(config.credential.value, true, false, true); const value = JSON.parse(result.text!); if (!isRecord(value) || Object.keys(value).length !== 1 || !validJevKey(value.jev)) throw new JevStorageError("invalid"); return value.jev; }
  catch (error) { throw error instanceof JevStorageError ? error : new JevStorageError("read"); }
}
export async function saveJevSetup(options: { agentDir: string; enabled: boolean; source: JevCredentialSource; reference?: string; key?: string; projectRoot?: string; storeKeyring?: typeof storeKeyring; snapshot?: JevSetupSnapshot; beforeCommit?: () => Promise<void> }): Promise<void> {
  const agentDir = resolve(options.agentDir); const configPath = jevConfigPath(agentDir);
  return queued(configPath, async () => {
    const old = options.snapshot ?? await readJevSetupSnapshot(agentDir);
    const suppliedReference = options.reference?.trim();
    if (options.source === "file" && suppliedReference && !isAbsolute(suppliedReference)) throw new JevStorageError("invalid");
    const reference = options.source === "environment" ? suppliedReference : options.source === "file" ? suppliedReference || defaultJevCredentialPath(agentDir) : "pi-subagents/jev";
    if (!validReference(options.source, reference)) throw new JevStorageError("invalid");
    if (options.source === "file" && reference === configPath) throw new JevStorageError("invalid");
    const retaining = old.config?.credential.source === options.source && old.config.credential.value === reference && options.key === undefined;
    if (options.source !== "environment" && !retaining && !validJevKey(options.key)) throw new JevStorageError("invalid");
    const config: StoredJevConfig = { version: 1, enabled: options.enabled, credential: { source: options.source, value: reference } };
    let release: (() => Promise<void>) | undefined, configTemp: string | undefined, credentialTemp: string | undefined; let credentialWritten = false;
    try {
      await makeSafeDirectory(agentDir); release = await acquireLock(configPath);
      const current = await readJevSetupSnapshot(agentDir); if (!sameRevision(old.revision, current.revision)) throw new JevStorageError("changed");
      configTemp = await stagePrivate(configPath, `${JSON.stringify(config, null, 2)}\n`);
      let credentialRevision: JevRevision | undefined;
      if (options.source === "file" && !retaining) {
        await makeSafeDirectory(dirname(reference)); await ensureSafePath(reference, true, true);
        const previous = await readSafeText(reference, true, true, true); credentialRevision = previous.revision;
        if (previous.text !== undefined) { const parsed = JSON.parse(previous.text); if (!isRecord(parsed) || Object.keys(parsed).length !== 1 || !validJevKey(parsed.jev)) throw new JevStorageError("invalid"); }
        credentialTemp = await stagePrivate(reference, `${JSON.stringify({ jev: options.key }, null, 2)}\n`);
      }
      await options.beforeCommit?.();
      if (!sameRevision(old.revision, (await readJevSetupSnapshot(agentDir)).revision)) throw new JevStorageError("changed");
      if (credentialTemp) { if (!sameRevision(credentialRevision, (await readSafeText(reference, true, true, true)).revision)) throw new JevStorageError("changed"); await rename(credentialTemp, reference); credentialTemp = undefined; credentialWritten = true; }
      else if (options.source === "keyring" && !retaining) { try { await (options.storeKeyring ?? storeKeyring)(options.key!); } catch { throw new JevStorageError("keyring"); } credentialWritten = true; }
      if (!sameRevision(old.revision, (await readJevSetupSnapshot(agentDir)).revision)) throw new JevStorageError("changed");
      await rename(configTemp, configPath); configTemp = undefined;
    } catch (error) { if (credentialWritten) throw new JevStorageError("partial"); throw error instanceof JevStorageError ? error : new JevStorageError("write"); }
    finally { for (const path of [configTemp, credentialTemp]) if (path) await rm(path, { force: true }).catch(() => undefined); await release?.().catch(() => undefined); }
  });
}
export async function testJevConnection(apiKey: string, fetchImpl: JevFetch = fetch, signal?: AbortSignal): Promise<void> { if (!validJevKey(apiKey)) throw new JevStorageError("invalid"); try { await requestJevConnection({ apiKey, fetchImpl, signal }); } catch { if (signal?.aborted) throw new Error("Jev connection test was cancelled."); throw new Error("Jev connection test failed."); } }
async function storeKeyring(key: string): Promise<void> { if (process.platform !== "linux") throw new JevStorageError("keyring"); await secretTool(["store", "--label=Pi subagents Jev", ...KEYRING_ARGS], key); }
async function lookupKeyring(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<string> { if (process.platform !== "linux") throw new JevStorageError("keyring"); const key = await secretTool(["lookup", ...KEYRING_ARGS], undefined, env, signal); if (!validJevKey(key)) throw new JevStorageError("keyring"); return key; }
function secretTool(args: string[], stdin?: string, env = process.env, signal?: AbortSignal): Promise<string> { return new Promise((resolvePromise, reject) => { const child = execFile("secret-tool", args, { env, signal, timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 16_386, encoding: "utf8", shell: false }, (error, stdout) => error ? reject(new JevStorageError("keyring")) : resolvePromise(stdout.slice(0, 16_385).replace(/\r?\n$/, ""))); child.stdin?.on("error", () => undefined); child.stdin?.end(stdin); }); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
