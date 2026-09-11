import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { configPath, parseConfig, type WebConfig } from "./config.js";
import { readCredentialEntries, validApiKey } from "./credentials.js";
import { KEYRING_SETUP_HELP, storeKeyring } from "./keyring.js";

export type Provider = keyof WebConfig["credentials"];
export type Storage = "keep" | "file" | "keyring";
export interface SetupDraft {
  provider: Provider;
  enabled: boolean;
  searchModel?: string;
  researchModel?: string;
  synthesisModel?: string;
  storage: Storage;
}
interface Revision { hash: string; ino: number; dev: number; mode: number }
export interface SetupSnapshot {
  agentDir: string;
  config: WebConfig;
  root: Record<string, unknown>;
  revision?: Revision;
}
export class SetupError extends Error {
  constructor(readonly code: "read" | "unsafe" | "busy" | "changed" | "invalid" | "write" | "keyring" | "partial") {
    super({
      read: "Cannot read web-access.json. Check its JSON and permissions before reopening setup.",
      unsafe: "Unsafe web-access path. Use regular files owned by you and no symlinks. Only web-access.credentials.json requires mode 0600; existing directory permissions are left unchanged.",
      busy: "Web access setup is busy. Retry after the other save finishes. Remove web-access.json.lock only after checking that no Pi process is saving.",
      changed: "Web access settings changed since setup opened. Cancel and reopen /web-access to review the latest settings.",
      invalid: "Invalid setup values. Review the model IDs and enter a non-empty API key without whitespace.",
      write: "Could not save web access. Check directory permissions and free space, then retry.",
      keyring: KEYRING_SETUP_HELP,
      partial: "Settings were not saved, but the API key may already have been stored. Check permissions and reopen setup before retrying. No automatic storage fallback was used.",
    }[code]);
  }
}
export function setupErrorMessage(error: unknown): string {
  return error instanceof SetupError ? error.message : new SetupError("write").message;
}
const MAX_BYTES = 64 * 1024;
function same(left?: Revision, right?: Revision): boolean {
  return left?.hash === right?.hash && left?.ino === right?.ino && left?.dev === right?.dev && left?.mode === right?.mode;
}

/** Bounded descriptor read; only credentials require 0600, saves are always private. */
async function readText(path: string, privateMode = false): Promise<{ text?: string; revision?: Revision }> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new SetupError("unsafe");
  });
  if (!info) return {};
  if (!info.isFile() || info.isSymbolicLink()) throw new SetupError("unsafe");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw new SetupError("unsafe");
  });
  if (!file) return {};
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev || stat.size > MAX_BYTES || process.platform !== "win32" &&
      (stat.uid !== process.getuid?.() || privateMode && (stat.mode & 0o777) !== 0o600)) throw new SetupError("unsafe");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new SetupError("unsafe");
    const text = buffer.subarray(0, size).toString("utf8");
    return { text, revision: { hash: createHash("sha256").update(text).digest("hex"), ino: stat.ino, dev: stat.dev, mode: stat.mode } };
  } finally { await file.close(); }
}

export async function readSetupSnapshot(agentDir = getAgentDir()): Promise<SetupSnapshot> {
  try {
    const { text, revision } = await readText(configPath(agentDir));
    const root = text === undefined ? {} : JSON.parse(text) as Record<string, unknown>;
    return { agentDir, root, config: parseConfig(root, agentDir), revision };
  } catch (error) { throw error instanceof SetupError ? error : new SetupError("read"); }
}

async function safeParent(directory: string): Promise<void> {
  const parent = dirname(directory);
  if (parent !== directory) await safeParent(parent);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const info = await lstat(directory);
  // Existing directories belong to the user's setup; don't impose or change their modes.
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SetupError("unsafe");
}

async function lock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  // A bounded, exclusive lock shared by all web-access setup processes. Never steal stale locks.
  const file = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
    throw new SetupError(error.code === "EEXIST" ? "busy" : "write");
  });
  const identity = await file.stat();
  return async () => {
    await file.close();
    const current = await lstat(lockPath).catch(() => undefined);
    if (current?.ino === identity.ino && current.dev === identity.dev) await rm(lockPath);
  };
}

async function stage(path: string, text: string): Promise<string> {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new SetupError("invalid");
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.chmod(0o600);
    await file.writeFile(text);
    await file.sync();
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  } finally { await file.close(); }
  return temporary;
}
function encode(root: Record<string, unknown>): string { return `${JSON.stringify(root, null, 2)}\n`; }
export function validModel(value: string, synthesis = false): boolean {
  return value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value) && (!synthesis || value.includes("/"));
}

/** Preserve the raw optional settings rather than serializing defaults back into the config. */
export function applySetup(snapshot: SetupSnapshot, draft: SetupDraft): Record<string, unknown> {
  if (!["gemini", "openai", "brave"].includes(draft.provider) || !["keep", "file", "keyring"].includes(draft.storage) || typeof draft.enabled !== "boolean") throw new SetupError("invalid");
  const root = structuredClone(snapshot.root);
  const search = { ...(root.search as Record<string, unknown> ?? {}), provider: draft.provider } as Record<string, unknown>;
  const research = { ...(root.research as Record<string, unknown> ?? {}) };
  if (draft.provider !== "brave") {
    const field = draft.provider === "gemini" ? "geminiModel" : "openaiModel";
    for (const [value, initial] of [[draft.searchModel, snapshot.config.search[field]], [draft.researchModel, snapshot.config.research[field]]]) {
      if (!value || value !== initial && !validModel(value)) throw new SetupError("invalid");
    }
    if (draft.searchModel !== snapshot.config.search[field]) search[field] = draft.searchModel;
    if (draft.researchModel !== snapshot.config.research[field]) research[field] = draft.researchModel;
  }
  if (draft.synthesisModel !== snapshot.config.synthesisModel) {
    if (draft.synthesisModel !== undefined && !validModel(draft.synthesisModel, true)) throw new SetupError("invalid");
    if (draft.synthesisModel === undefined) delete root.synthesisModel;
    else root.synthesisModel = draft.synthesisModel;
  }
  if (draft.enabled !== snapshot.config.enabled) root.enabled = draft.enabled;
  root.search = search;
  if (Object.keys(research).length) root.research = research;
  if (draft.storage !== "keep") root.credentials = { ...(root.credentials as Record<string, unknown> ?? {}), [draft.provider]: `${draft.storage}:pi-web-access/${draft.provider}` };
  parseConfig(root, snapshot.agentDir);
  return root;
}

/** Called only after the user confirms. No provider API calls or credential reads during the wizard. */
export async function saveSetup(snapshot: SetupSnapshot, draft: SetupDraft, key?: string, options: {
  storeKeyring?: typeof storeKeyring;
  beforeCommit?: () => Promise<void>;
} = {}): Promise<void> {
  const settings = encode(applySetup(snapshot, draft));
  if (draft.storage !== "keep" && !validApiKey(key)) throw new SetupError("invalid");
  const path = configPath(snapshot.agentDir);
  const credentialPath = join(snapshot.agentDir, "web-access.credentials.json");
  return withFileMutationQueue(path, () => withFileMutationQueue(credentialPath, async () => {
    let release: (() => Promise<void>) | undefined;
    let configTemp: string | undefined;
    let credentialTemp: string | undefined;
    let credentialWritten = false;
    try {
      await safeParent(resolve(snapshot.agentDir));
      release = await lock(path);
      if (!same(snapshot.revision, (await readText(path)).revision)) throw new SetupError("changed");
      configTemp = await stage(path, settings);
      let credentialRevision: Revision | undefined;
      if (draft.storage === "file") {
        const previous = await readText(credentialPath, true);
        credentialRevision = previous.revision;
        const entries = await readCredentialEntries(credentialPath, undefined, true);
        if (!same(credentialRevision, (await readText(credentialPath, true)).revision)) throw new SetupError("changed");
        entries[draft.provider] = key!;
        credentialTemp = await stage(credentialPath, encode(entries));
      }
      await options.beforeCommit?.();
      if (!same(snapshot.revision, (await readText(path)).revision)) throw new SetupError("changed");
      if (credentialTemp) {
        if (!same(credentialRevision, (await readText(credentialPath, true)).revision)) throw new SetupError("changed");
        await rename(credentialTemp, credentialPath);
        credentialWritten = true;
      } else if (draft.storage === "keyring") {
        try { await (options.storeKeyring ?? storeKeyring)(draft.provider, key!); }
        catch { throw new SetupError("keyring"); }
        credentialWritten = true;
      }
      if (!same(snapshot.revision, (await readText(path)).revision)) throw new SetupError("changed");
      await rename(configTemp, path);
    } catch (error) {
      if (credentialWritten) throw new SetupError("partial");
      throw error instanceof SetupError ? error : new SetupError("write");
    } finally {
      for (const temporary of [configTemp, credentialTemp]) if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
      await release?.().catch(() => undefined);
    }
  }));
}
