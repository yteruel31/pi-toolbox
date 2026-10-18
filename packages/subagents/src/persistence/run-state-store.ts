import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isSettledStatus, type PersistedRunRecord, type PersistedRunState, type ResultConsumption } from "../shared/types.js";
import { isPersistedState } from "./validation.js";

export const STATE_ENTRY_V1 = "pi-subagents-state-v1";
export const STATE_ENTRY_V2 = "pi-subagents-state-v2";
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^run-[1-9][0-9]{0,15}$/;
const CONSUMPTIONS = new Set(["none", "waited", "delivered", "suppressed"]);

export interface CompactRunState {
  version: 2;
  /** Hashed source session identity; retained in forks so old references work. */
  namespace: string;
  nextSerial: number;
  nextSettlementSeq: number;
  runs: Array<{ id: string; artifact: string; consumption: ResultConsumption }>;
}

type RunMetadata = Omit<PersistedRunRecord, "consumption" | "activity" | "transcript" | "finalText" | "errorText">;
interface RunArtifact {
  version: 1;
  record: RunMetadata;
  activity: string[];
  transcript?: string[];
  finalText?: string;
  errorText?: string;
}

export class RunStateStorageError extends Error {
  constructor(operation: "read" | "write" | "validate", reason?: "missing-artifact" | "integrity" | "unsafe-path") {
    // Do not echo file contents, arbitrary filesystem errors, or session data.
    super(`Subagent state ${operation} failed${reason ? ` (${reason})` : ""}; results were not safely persisted/restored. Check the private subagent artifact store before retrying.`);
    this.name = "RunStateStorageError";
  }
}

/**
 * Synchronous commit adapter for the manager's synchronous lifecycle contract.
 * Payload chunks are immutable and content-addressed: even active transcript
 * revisions only write NEW entries, never the whole accumulated transcript.
 * Files are durable before the caller appends the compact session checkpoint.
 */
export class FileRunStateStore {
  private readonly namespace: string;
  private readonly terminal = new Map<string, { seq: number | undefined; at: number | undefined; artifact: string }>();
  private readonly written = new Set<string>();

  constructor(private readonly root: string, sessionId: string) {
    this.root = path.resolve(root);
    this.namespace = digest(sessionId);
  }

  save(state: PersistedRunState): CompactRunState {
    try {
      if (!isPersistedState(state)) throw new RunStateStorageError("validate");
      this.directory(this.namespace, true);
      const runs = state.runs.map((run) => {
        if (!RUN_ID.test(run.id)) throw new RunStateStorageError("validate");
        const cached = this.terminal.get(run.id);
        let artifact: string;
        // Terminal payloads are immutable in RunManager; only consumption changes.
        if (isSettledStatus(run.status) && cached && cached.seq === run.settlementSeq && cached.at === run.settledAt) {
          artifact = cached.artifact;
        } else {
          const { consumption: _consumption, activity, transcript, finalText, errorText, ...record } = run;
          const descriptor: RunArtifact = {
            version: 1,
            record,
            activity: activity.map((entry) => this.put(entry)),
            ...(transcript === undefined ? {} : { transcript: transcript.map((entry) => this.put(entry)) }),
            ...(finalText === undefined ? {} : { finalText: this.put(finalText) }),
            ...(errorText === undefined ? {} : { errorText: this.put(errorText) }),
          };
          artifact = this.put(descriptor);
          if (isSettledStatus(run.status)) this.terminal.set(run.id, { seq: run.settlementSeq, at: run.settledAt, artifact });
        }
        return { id: run.id, artifact, consumption: run.consumption };
      });
      const compact: CompactRunState = {
        version: 2, namespace: this.namespace,
        nextSerial: state.nextSerial, nextSettlementSeq: state.nextSettlementSeq, runs,
      };
      // A measurable bound independent of all prompt/transcript/result sizes.
      if (Buffer.byteLength(JSON.stringify(compact)) > 256 + 160 * runs.length) throw new RunStateStorageError("validate");
      return compact;
    } catch (error) {
      throw error instanceof RunStateStorageError ? error : new RunStateStorageError("write");
    }
  }

  restore(value: unknown): PersistedRunState {
    // A new manager/branch can reuse run ids and settlement timestamps.
    this.terminal.clear();
    try {
      if (isPersistedState(value)) return value;
      if (!isCompactState(value)) throw new RunStateStorageError("validate");
      const runs = value.runs.map(({ id, artifact, consumption }) => {
        const descriptor = this.get(value.namespace, artifact);
        if (!isRunArtifact(descriptor)) throw new RunStateStorageError("validate");
        // Project only known descriptor fields. Never spread untrusted references
        // into paths, or trust an artifact's consumption over the checkpoint.
        const run = {
          ...descriptor.record, consumption,
          activity: descriptor.activity.map((hash) => this.get(value.namespace, hash)),
          ...(descriptor.transcript === undefined ? {} : { transcript: descriptor.transcript.map((hash) => this.get(value.namespace, hash)) }),
          ...(descriptor.finalText === undefined ? {} : { finalText: this.get(value.namespace, descriptor.finalText) }),
          ...(descriptor.errorText === undefined ? {} : { errorText: this.get(value.namespace, descriptor.errorText) }),
        };
        if (run.id !== id) throw new RunStateStorageError("validate");
        return run;
      });
      const state = { version: 1, nextSerial: value.nextSerial, nextSettlementSeq: value.nextSettlementSeq, runs };
      if (!isPersistedState(state)) throw new RunStateStorageError("validate");
      return state;
    } catch (error) {
      throw error instanceof RunStateStorageError ? error : new RunStateStorageError("read",
        (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing-artifact" : undefined);
    }
  }

  private directory(namespace: string, create: boolean): string {
    if (!HASH.test(namespace)) throw new RunStateStorageError("validate");
    const directory = path.join(this.root, namespace);
    // Reject symlinks at every ancestor, not just the final file. The root is
    // trusted local configuration, never a path supplied by a session entry.
    let current = path.parse(directory).root;
    for (const segment of directory.slice(current.length).split(path.sep)) {
      current = path.join(current, segment);
      if (create && !fs.existsSync(current)) {
        try {
          fs.mkdirSync(current, { mode: 0o700 });
          syncDirectory(path.dirname(current));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RunStateStorageError(create ? "write" : "read", "unsafe-path");
      if (process.platform !== "win32") {
        const privateDirectory = current === this.root || current === directory;
        const stickySystem = stat.uid === 0 && (stat.mode & 0o1000) !== 0;
        if (privateDirectory && (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) ||
            !stickySystem && (stat.mode & 0o002) !== 0) throw new RunStateStorageError(create ? "write" : "read", "unsafe-path");
      }
    }
    return directory;
  }

  private put(value: unknown): string {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > MAX_BLOB_BYTES) throw new RunStateStorageError("write");
    const hash = digest(text);
    if (this.written.has(hash)) return hash;
    const directory = this.directory(this.namespace, true);
    const target = path.join(directory, `${hash}.json`);
    if (fs.existsSync(target)) {
      this.get(this.namespace, hash); // Do not silently accept corrupt existing data.
      syncDirectory(directory); // Also completes a previously failed directory sync.
    } else {
      const temporary = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.fchmodSync(fd, 0o600);
          fs.writeFileSync(fd, text, "utf8");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        fs.renameSync(temporary, target);
        syncDirectory(directory);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    this.written.add(hash);
    return hash;
  }

  private get(namespace: string, hash: string): unknown {
    if (!HASH.test(hash)) throw new RunStateStorageError("validate");
    const file = path.join(this.directory(namespace, false), `${hash}.json`);
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) throw new RunStateStorageError("read", "unsafe-path");
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > MAX_BLOB_BYTES || process.platform !== "win32" &&
          (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)) throw new RunStateStorageError("read");
      // Bound the actual read too, even if a file grows after fstat.
      const buffer = Buffer.alloc(stat.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!count) break;
        length += count;
      }
      const data = buffer.subarray(0, length);
      if (length !== stat.size || digest(data) !== hash) throw new RunStateStorageError("read", "integrity");
      return JSON.parse(data.toString("utf8"));
    } finally { fs.closeSync(fd); }
  }
}

function syncDirectory(directory: string): void {
  // Node on Windows cannot open directories for fsync. File sync and atomic
  // rename still apply there; do not suppress any actual POSIX I/O failures.
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function hashes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 1_000 && value.every((hash) => typeof hash === "string" && HASH.test(hash));
}
function isRunArtifact(value: unknown): value is RunArtifact {
  return isRecord(value) && value.version === 1 && isRecord(value.record) && hashes(value.activity) &&
    (value.transcript === undefined || hashes(value.transcript)) &&
    (value.finalText === undefined || typeof value.finalText === "string" && HASH.test(value.finalText)) &&
    (value.errorText === undefined || typeof value.errorText === "string" && HASH.test(value.errorText));
}
function isCompactState(value: unknown): value is CompactRunState {
  if (!isRecord(value) || value.version !== 2 || typeof value.namespace !== "string" || !HASH.test(value.namespace) ||
      !positive(value.nextSerial) || !positive(value.nextSettlementSeq) || !Array.isArray(value.runs) || value.runs.length > 10_000) return false;
  const ids = new Set<string>();
  return value.runs.every((run) => {
    if (!isRecord(run) || typeof run.id !== "string" || !RUN_ID.test(run.id) || ids.has(run.id) ||
        typeof run.artifact !== "string" || !HASH.test(run.artifact) || typeof run.consumption !== "string" || !CONSUMPTIONS.has(run.consumption)) return false;
    ids.add(run.id);
    return true;
  });
}
