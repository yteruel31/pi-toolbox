import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { WebConfig } from "./config.js";
import { resolveKey } from "./config.js";
import { atomicWrite, hash, readPrivate, safeDirectory, validId, withLock } from "./store.js";
import { startResearch, getResearch, cancelResearch, type ResearchProvider, type ResearchSnapshot } from "./providers.js";

export interface Job {
  version: 1; researchId: string; provider: ResearchProvider; model: string; subject: string;
  createdAt: string; updatedAt: string; status: string; upstreamId?: string;
  outputPath: string; outputWritten?: boolean; resultStored?: boolean; preview?: string; usage?: unknown; progress?: string;
  error?: string; outputError?: string; submittingPid?: number;
}
export interface StartInput { provider: ResearchProvider; subject: string; model?: string; outputPath?: string; requestKey?: string }
export interface ResearchDeps {
  start: typeof startResearch; get: typeof getResearch; cancel: typeof cancelResearch;
  key: (provider: ResearchProvider) => string | Promise<string>;
}
const RUNNING = new Set(["queued", "in_progress"]);
const TERMINAL = new Set(["completed", "cancelled", "failed", "incomplete", "budget_exceeded", "requires_action"]);
export class ResearchManager {
  private stopped = false;
  private readonly tasks = new Map<string, Promise<void>>();
  private timer?: ReturnType<typeof setTimeout>;
  private pollTask?: Promise<void>;
  private readonly shutdown = new AbortController();
  private readonly deps: ResearchDeps;
  constructor(readonly config: WebConfig, readonly directory: string, deps: Partial<ResearchDeps> = {}, readonly notify: (job: Job) => void = () => {}) {
    this.deps = { start: startResearch, get: getResearch, cancel: cancelResearch, key: (provider) => resolveKey(config, provider, process.env, this.shutdown.signal), ...deps };
  }
  private emit(job: Job): void { if (!this.stopped) this.notify(job); }
  private path(id: string): string { return join(this.directory, `${validId(id)}.json`); }
  private async save(job: Job): Promise<void> { job.updatedAt = new Date().toISOString(); await atomicWrite(this.path(job.researchId), JSON.stringify(job), true); }
  async read(id: string): Promise<Job> {
    const job = JSON.parse(await readPrivate(this.path(id), 128 * 1024)) as Job;
    if (job.version !== 1 || job.researchId !== id || !["gemini", "openai"].includes(job.provider) || typeof job.subject !== "string" || typeof job.model !== "string" || !isAbsolute(job.outputPath)) throw new Error("Invalid research record");
    return job;
  }
  async list(): Promise<Job[]> {
    await safeDirectory(this.directory);
    const names = (await readdir(this.directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const jobs: Job[] = [];
    for (const name of names) jobs.push(await this.read(name.slice(0, -5)));
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async outputPath(path: string): Promise<string> {
    if (/[\x00-\x1f\x7f]/.test(path)) throw new Error("Research output path cannot contain control characters");
    const absolute = resolve(path.replace(/^@/, ""));
    if (!absolute.endsWith(".md")) throw new Error("Research output path must end with .md");
    await safeDirectory(dirname(absolute));
    try { await lstat(absolute); throw new Error("Research output already exists; choose a new .md path"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return absolute;
  }
  async start(input: StartInput, cwd: string): Promise<Job> {
    if (this.stopped) throw new Error("Research runtime is shutting down");
    if (!input.subject.trim() || input.subject.length > 50_000) throw new Error("Research subject must contain 1 to 50000 characters");
    const model = input.model ?? (input.provider === "gemini" ? this.config.research.geminiModel : this.config.research.openaiModel);
    if (!model.trim() || model.length > 200) throw new Error("Invalid research model/agent");
    const apiKey = await this.deps.key(input.provider); // Fail before creating a job when API auth is unavailable.
    if (this.stopped) throw new Error("Research runtime is shutting down");
    const requestedPath = input.outputPath ? resolve(cwd, input.outputPath.replace(/^@/, "")) : undefined;
    const destination = requestedPath ? { file: requestedPath } : { directory: resolve(this.config.research.outputDir) };
    const researchId = hash(JSON.stringify([input.provider, model, input.subject, destination, input.requestKey ?? ""]));
    let created = false;
    const job = await withLock(this.directory, async () => {
      try { return await this.read(researchId); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const jobs = await this.list();
      if (jobs.length >= 128) throw new Error("Research history is full (128 jobs); archive old records manually before starting more");
      if (jobs.filter((job) => RUNNING.has(job.status) || job.status === "submitting").length >= 4) throw new Error("Four research jobs are already active");
      const outputPath = await this.outputPath(requestedPath ?? join(this.config.research.outputDir, `${researchId}.md`));
      const now = new Date().toISOString();
      const result: Job = { version: 1, researchId, provider: input.provider, model, subject: input.subject, createdAt: now, updatedAt: now, status: "submitting", outputPath, submittingPid: process.pid };
      await atomicWrite(this.path(researchId), JSON.stringify(result)); created = true; return result;
    });
    if (created) this.schedule(job.researchId, () => this.submit(job, apiKey));
    this.arm();
    return job;
  }
  private schedule(id: string, action: () => Promise<void>): void {
    if (this.stopped || this.tasks.has(id)) return;
    const task = Promise.resolve().then(action).catch(async () => {
      // Disk failures are not turned into a new provider submission.
      try { const job = await this.read(id); this.emit({ ...job, error: "Research tracking failed; inspect the saved record before retrying" }); } catch { /* no safe record available */ }
    }).finally(() => this.tasks.delete(id));
    this.tasks.set(id, task);
  }
  private async submit(job: Job, apiKey: string): Promise<void> {
    await withLock(join(this.directory, job.researchId), async () => {
      try {
        const snapshot = await this.deps.start(job.provider, `${job.subject}\n\nWrite the complete report in English Markdown with source citations. Do not omit the report in favor of a summary.`, { apiKey, model: job.model, signal: this.shutdown.signal });
        // Persist the upstream ID before attempting any report writes.
        job.upstreamId = snapshot.upstreamId; job.status = snapshot.status; delete job.submittingPid; await this.save(job);
        await this.accept(job, snapshot);
      } catch (error) {
        if (!job.upstreamId) { job.status = "submission_unknown"; job.error = "Submission did not return a durable provider ID. It may have been accepted and billed. Do not resubmit blindly; recover the provider ID and attach it using status."; }
        else job.error = safeError(error);
        await this.save(job); this.emit(job);
      }
    });
  }
  private async accept(job: Job, snapshot: ResearchSnapshot): Promise<void> {
    if (snapshot.upstreamId !== job.upstreamId) throw new Error("Provider returned a different research ID");
    job.status = snapshot.status; job.usage = snapshot.usage; job.progress = snapshot.progress?.slice(0, 500); job.error = snapshot.error;
    if (TERMINAL.has(job.status)) {
      await atomicWrite(join(this.directory, job.researchId, "result.json"), JSON.stringify(snapshot), true);
      job.resultStored = true;
      if (snapshot.report) {
        job.preview = snapshot.report.slice(0, 600);
        await this.publish(job, snapshot);
      } else if (job.status === "completed") job.outputError = "Provider completed without a text report; no file was written";
    }
    await this.save(job);
    if (TERMINAL.has(job.status)) this.emit(job);
  }
  private async publish(job: Job, snapshot: ResearchSnapshot): Promise<void> {
    if (job.outputWritten) return;
    const metadata: Record<string, unknown> = { subject: job.subject, provider: job.provider, model: job.model, date: job.createdAt, research_id: job.researchId, provider_id: job.upstreamId, status: job.status, usage: job.usage ?? null };
    const frontmatter = Object.entries(metadata).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n");
    const sources = snapshot.citations.map((source, i) => `${i + 1}. ${source.title.replace(/[\r\n]/g, " ")} <${source.url.replace(/[<>\r\n]/g, "")}>`).join("\n");
    const text = `---\n${frontmatter}\n---\n\n${snapshot.report}\n\n${sources ? `## Sources\n\n${sources}\n\n` : ""}<!-- AI generated -->\n`;
    try { await atomicWrite(job.outputPath, text); job.outputWritten = true; delete job.outputError; }
    catch { job.outputError = "Report retained locally, but output could not be published without overwriting. Use result with a new outputPath."; }
  }
  async refresh(id: string, upstreamId?: string): Promise<Job> {
    if (this.tasks.has(id)) return this.read(id);
    return withLock(join(this.directory, validId(id)), async () => {
      const job = await this.read(id);
      if (upstreamId) {
        if (!/^[A-Za-z0-9_-]{1,512}$/.test(upstreamId) || (job.upstreamId && job.upstreamId !== upstreamId)) throw new Error("Invalid or conflicting provider research ID");
        job.upstreamId = upstreamId; job.status = "in_progress"; delete job.error; await this.save(job);
      }
      if (!needsRetrieval(job)) return job;
      try { await this.accept(job, await this.deps.get(job.provider, job.upstreamId!, { apiKey: await this.deps.key(job.provider), model: job.model, signal: this.shutdown.signal })); }
      catch (error) { job.error = safeError(error); await this.save(job); }
      return job;
    });
  }
  async cancel(id: string): Promise<Job> {
    const task = this.tasks.get(id); if (task) await task;
    return withLock(join(this.directory, validId(id)), async () => {
      const job = await this.read(id);
      if (TERMINAL.has(job.status)) return job;
      if (!job.upstreamId) throw new Error("Cannot confirm cancellation without a provider ID. Recover the ID first; local stop is not upstream cancellation.");
      const snapshot = await this.deps.cancel(job.provider, job.upstreamId, { apiKey: await this.deps.key(job.provider), model: job.model, signal: this.shutdown.signal });
      await this.accept(job, snapshot); return job;
    });
  }
  async result(id: string, outputPath?: string, cwd = process.cwd()): Promise<Job> {
    await this.refresh(id);
    return withLock(join(this.directory, validId(id)), async () => {
      const job = await this.read(id);
      if (outputPath) {
        if (job.outputWritten) throw new Error("Report has already been published; use the returned path");
        job.outputPath = await this.outputPath(resolve(cwd, outputPath)); await this.save(job);
      }
      if (TERMINAL.has(job.status) && !job.outputWritten) {
        try { const snapshot = JSON.parse(await readPrivate(join(this.directory, id, "result.json"))) as ResearchSnapshot; if (snapshot.report) await this.publish(job, snapshot); await this.save(job); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (job.upstreamId) {
            job.resultStored = false;
            await this.save(job);
            await this.accept(job, await this.deps.get(job.provider, job.upstreamId, { apiKey: await this.deps.key(job.provider), model: job.model, signal: this.shutdown.signal }));
          }
        }
      }
      return job;
    });
  }
  async content(id: string): Promise<string> {
    const job = await this.read(id);
    if (!job.outputWritten) throw new Error("Report is not yet available; call deep_research result");
    return readPrivate(job.outputPath);
  }
  async recover(): Promise<void> {
    for (const job of await this.list()) {
      if (job.status === "submitting" && !this.tasks.has(job.researchId) && !processAlive(job.submittingPid)) {
        job.status = "submission_unknown"; job.error = "Pi stopped during submission. Recover the provider ID rather than creating another paid job."; await this.save(job);
      }
    }
    this.arm();
  }
  private arm(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pollTask = this.list().then(async (jobs) => {
        for (const job of jobs) if (needsRetrieval(job)) await this.refresh(job.researchId);
      }).catch(() => {}).finally(() => this.arm());
    }, this.config.research.pollIntervalMs);
    this.timer.unref();
  }
  async idle(): Promise<void> { await Promise.all(this.tasks.values()); }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.shutdown.abort(); await this.idle(); await this.pollTask; }
}
function needsRetrieval(job: Job): boolean {
  return !!job.upstreamId && (RUNNING.has(job.status) || (TERMINAL.has(job.status) && !job.resultStored));
}
function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function safeError(error: unknown): string {
  // Provider adapters already redact transport/API bodies. Keep diagnostics bounded.
  return error instanceof Error ? error.message.slice(0, 600) : "Research provider request failed";
}
