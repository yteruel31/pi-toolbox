import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { normalizeSpec, type DiagramSpec } from "./spec.js";

export interface DiagramDocument {
  id: string;
  token: string;
  title: string;
  spec: DiagramSpec;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const DOCUMENT_ID = /^diag_[0-9a-f]{12}$/;
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const MAX_DOCUMENTS = 100;

export function defaultStoreDirectory(home = homedir()): string {
  return join(home, ".pi", "agent", "diagram", "documents");
}

export class DiagramStore {
  private readonly documents = new Map<string, DiagramDocument>();
  private readonly tokenIndex = new Map<string, string>();
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(readonly directory = defaultStoreDirectory()) {}

  async create(title: string, specValue: unknown): Promise<DiagramDocument> {
    const normalizedTitle = normalizeTitle(title);
    const spec = normalizeSpec(specValue);
    return this.mutate(async () => {
      if (this.documents.size >= MAX_DOCUMENTS) throw new Error(`Diagram store is limited to ${MAX_DOCUMENTS} documents`);
      let id: string;
      do id = `diag_${randomBytes(6).toString("hex")}`;
      while (this.documents.has(id));
      let token: string;
      do token = randomBytes(32).toString("base64url");
      while (this.tokenIndex.has(token));
      const now = new Date().toISOString();
      const document: DiagramDocument = { id, token, title: normalizedTitle, spec, revision: 1, createdAt: now, updatedAt: now };
      await this.persist(document);
      this.remember(document);
      return cloneDocument(document);
    });
  }

  async update(id: string, change: { title?: string; spec: DiagramSpec }): Promise<DiagramDocument> {
    return this.updateWith(id, () => change);
  }

  async updateWith(id: string, transform: (current: DiagramDocument) => { title?: string; spec: DiagramSpec }): Promise<DiagramDocument> {
    return this.mutate(async () => {
      const current = this.documents.get(id);
      if (!current) throw new Error(`Unknown diagram: ${id}`);
      const change = transform(cloneDocument(current));
      const document: DiagramDocument = {
        ...current,
        title: change.title === undefined ? current.title : normalizeTitle(change.title),
        spec: normalizeSpec(change.spec),
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await this.persist(document);
      this.remember(document);
      return cloneDocument(document);
    });
  }

  get(id: string): Promise<DiagramDocument | undefined> {
    return this.read(() => {
      const document = this.documents.get(id);
      return document ? cloneDocument(document) : undefined;
    });
  }

  getByToken(token: string): Promise<DiagramDocument | undefined> {
    return this.read(() => {
      const id = this.tokenIndex.get(token);
      if (!id) return undefined;
      const document = this.documents.get(id);
      return document ? cloneDocument(document) : undefined;
    });
  }

  list(): Promise<DiagramDocument[]> {
    return this.read(() => [...this.documents.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(cloneDocument));
  }

  async delete(id: string): Promise<boolean> {
    return this.mutate(async () => {
      const document = this.documents.get(id);
      if (!document) return false;
      await rm(this.pathFor(id), { force: true });
      this.documents.delete(id);
      this.tokenIndex.delete(document.token);
      return true;
    });
  }

  private async load(): Promise<void> {
    await secureDirectory(this.directory);
    const entries = await readdir(this.directory, { withFileTypes: true });
    const documents = new Map<string, DiagramDocument>();
    const tokenIndex = new Map<string, string>();
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const expectedId = entry.name.slice(0, -5);
      try {
        const text = await readFile(join(this.directory, entry.name), "utf8");
        const document = parseDocument(JSON.parse(text), expectedId);
        if (documents.size < MAX_DOCUMENTS && !tokenIndex.has(document.token)) {
          documents.set(document.id, document);
          tokenIndex.set(document.token, document.id);
        }
      } catch {
        // A corrupt or user-created file is ignored rather than making every diagram unavailable.
      }
    }
    this.documents.clear();
    this.tokenIndex.clear();
    for (const document of documents.values()) this.remember(document);
  }

  private remember(document: DiagramDocument): void {
    const previous = this.documents.get(document.id);
    if (previous && previous.token !== document.token) this.tokenIndex.delete(previous.token);
    this.documents.set(document.id, cloneDocument(document));
    this.tokenIndex.set(document.token, document.id);
  }

  private async persist(document: DiagramDocument): Promise<void> {
    await secureDirectory(this.directory);
    const path = this.pathFor(document.id);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private pathFor(id: string): string {
    if (!DOCUMENT_ID.test(id)) throw new Error("Invalid diagram id");
    return join(this.directory, `${id}.json`);
  }

  private read<T>(operation: () => T): Promise<T> {
    const next = this.mutationQueue.catch(() => undefined).then(async () => {
      await this.load();
      return operation();
    });
    this.mutationQueue = next;
    return next;
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutationQueue.catch(() => undefined).then(() => withStoreLock(this.directory, async () => {
      await this.load();
      return operation();
    }));
    this.mutationQueue = next;
    return next;
  }
}

async function withStoreLock<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  await secureDirectory(directory);
  const path = join(directory, ".mutation.lock");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const candidate = await open(path, "wx", 0o600);
      try { await candidate.writeFile(`${process.pid}\n`, "utf8"); }
      catch (error) { await candidate.close().catch(() => undefined); await rm(path, { force: true }); throw error; }
      handle = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const [lock, ownerText] = await Promise.all([stat(path), readFile(path, "utf8")]);
        const owner = Number(ownerText.trim());
        if (Date.now() - lock.mtimeMs > 1_000 && (!Number.isInteger(owner) || owner <= 0 || !processExists(owner))) await rm(path, { force: true });
      } catch (inspectionError) {
        if ((inspectionError as NodeJS.ErrnoException).code !== "ENOENT") throw inspectionError;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (!handle) throw new Error("Timed out waiting for the diagram store lock");
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    await rm(path, { force: true });
  }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

async function secureDirectory(directory: string): Promise<void> {
  try {
    const existing = await lstat(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Diagram storage path must be a real directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const created = await lstat(directory);
    if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("Diagram storage path must be a real directory");
  }
  await chmod(directory, 0o700);
}

function parseDocument(value: unknown, expectedId: string): DiagramDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid diagram document");
  const candidate = value as Record<string, unknown>;
  if (candidate.id !== expectedId || typeof candidate.id !== "string" || !DOCUMENT_ID.test(candidate.id)) throw new Error("Invalid diagram id");
  if (typeof candidate.token !== "string" || !CAPABILITY.test(candidate.token)) throw new Error("Invalid capability token");
  const title = normalizeTitle(candidate.title);
  if (!Number.isInteger(candidate.revision) || (candidate.revision as number) < 1) throw new Error("Invalid revision");
  if (!validTimestamp(candidate.createdAt) || !validTimestamp(candidate.updatedAt)) throw new Error("Invalid timestamp");
  return {
    id: candidate.id,
    token: candidate.token,
    title,
    spec: normalizeSpec(candidate.spec),
    revision: candidate.revision as number,
    createdAt: candidate.createdAt as string,
    updatedAt: candidate.updatedAt as string,
  };
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid title");
  return value;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function cloneDocument(document: DiagramDocument): DiagramDocument {
  return structuredClone(document);
}
