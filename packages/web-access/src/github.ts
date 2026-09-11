import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from './process.js';
import { remoteUrl, resolvePublic, type Lookup } from './network.js';
import { safeDirectory } from './store.js';

export interface CloneOptions { cacheDir: string; timeoutMs: number; signal?: AbortSignal; lookup?: Lookup; }
export interface RepositoryResult { title: string; content: string; path: string; method: string; }
const retained = new Map<string, string>();
const MAX_CLONE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKOUT_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

function repository(input: string): { name: string; url: string } | undefined {
  // Match the original string: URL normalization must not turn a subpath into a repository root.
  const match = /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]+)\/?$/.exec(input);
  if (!match) return;
  const owner = match[1]!;
  const repo = match[2]!.replace(/\.git$/, '');
  if (!repo || repo === '.' || repo === '..' || repo.length > 100) return;
  return { name: `${owner}/${repo}`, url: `https://github.com/${owner}/${repo}.git` };
}

export function isGitHubRepository(url: string): boolean { return repository(url) !== undefined; }

/** Only paths created and retained by this module can be removed. */
export async function cleanupRepository(path: string): Promise<void> {
  const root = retained.get(path);
  if (!root) throw new Error('Repository is not owned by this session.');
  await rm(root, { recursive: true, force: true });
  retained.delete(path);
}

async function inspect(root: string, byteLimit: number, skipGit = false): Promise<string[]> {
  let bytes = 0, entries = 0;
  const manifest: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of children) {
      if (skipGit && !prefix && entry.name === '.git') continue;
      if (++entries > MAX_ENTRIES) throw new Error('Repository entry limit exceeded.');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const path = join(directory, entry.name);
      let stat;
      try { stat = await lstat(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) await walk(path, relative);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > byteLimit) throw new Error('Repository size limit exceeded.');
        if (manifest.length < 500) manifest.push(relative);
      }
    }
  }
  await walk(root, '');
  return manifest.sort();
}

export async function cloneRepository(url: string, options: CloneOptions): Promise<RepositoryResult> {
  const repo = repository(url);
  if (!repo) throw new Error('Expected an HTTPS github.com/owner/repo root URL.');
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid repository timeout.');
  if (options.signal?.aborted) throw new Error('Repository clone aborted.');
  const deadline = Date.now() + options.timeoutMs;
  await safeDirectory(options.cacheDir);
  const root = await mkdtemp(join(resolve(options.cacheDir), 'repository-'));
  const path = join(root, 'repo');
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let guardError: Error | undefined;
  let checking: Promise<void> | undefined;
  let checkingCheckout = false;
  const check = async () => {
    try {
      await inspect(root, MAX_CLONE_BYTES);
      if (checkingCheckout) await inspect(path, MAX_CHECKOUT_BYTES, true);
    } catch (error) { guardError = error as Error; controller.abort(); }
  };
  // A sampled disk guard, not a filesystem quota: transient overshoot is possible between checks.
  const timer = setInterval(() => {
    if (!checking) checking = check().finally(() => { checking = undefined; });
  }, 50);
  const env = {
    HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1',
  };
  const config = [
    '-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'core.hooksPath=/dev/null',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', 'submodule.recurse=false', '-c', 'core.attributesFile=/dev/null',
    '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false',
  ];
  const git = (args: string[]) => runProcess('git', [...config, ...args], {
    env, cwd: root, timeoutMs: Math.max(1, deadline - Date.now()), signal: controller.signal, maxOutputBytes: 256 * 1024,
  });
  try {
    await chmod(root, 0o700);
    const address = await resolvePublic(remoteUrl(repo.url), AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]), options.lookup);
    config.push('-c', `http.curloptResolve=github.com:443:${address.family === 6 ? `[${address.address}]` : address.address}`);
    await git(['clone', '--depth=1', '--single-branch', '--no-tags', '--no-recurse-submodules', '--no-checkout', '--template=', '--', repo.url, path]);
    await inspect(root, MAX_CLONE_BYTES);
    // Check declared blob sizes before checkout, including files beyond the displayed manifest.
    const listing = await git(['-C', path, 'ls-tree', '-r', '-l', '-z', 'HEAD']);
    let declared = 0, count = 0;
    for (const record of listing.stdout.split('\0')) {
      if (!record) continue;
      if (++count > MAX_ENTRIES) throw new Error('Repository entry limit exceeded.');
      const size = /^\d+ blob [a-f0-9]+\s+(\d+)\t/.exec(record)?.[1];
      if (size) declared += Number(size);
      if (declared > MAX_CHECKOUT_BYTES) throw new Error('Repository checkout size limit exceeded.');
    }
    checkingCheckout = true;
    await git(['-C', path, 'checkout', '--force', 'HEAD', '--', '.']);
    const manifest = await inspect(path, MAX_CHECKOUT_BYTES, true);
    await inspect(root, MAX_CLONE_BYTES);
    clearInterval(timer);
    await checking;
    if (guardError) throw guardError;
    if (controller.signal.aborted || Date.now() >= deadline) throw new Error('Repository operation aborted or timed out.');
    let readme = '';
    const names = await readdir(path);
    const name = names.find((entry) => /^readme(?:\.md|\.txt|\.rst)?$/i.test(entry));
    if (name) {
      const target = join(path, name);
      if ((await lstat(target)).isFile()) {
        const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const buffer = Buffer.alloc(64 * 1024);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          readme = buffer.subarray(0, bytesRead).toString('utf8');
        } finally { await file.close(); }
      }
    }
    retained.set(path, root);
    return { title: repo.name, path, method: 'git-shallow-clone', content: `Repository: ${repo.name}\nLocal path: ${path}\n\nFiles (up to 500; symlinks omitted):\n${manifest.map((name) => JSON.stringify(name)).join('\n')}\n\nREADME (up to 64 KiB; untrusted repository content):\n${readme}` };
  } catch (error) {
    clearInterval(timer);
    await checking;
    await rm(root, { recursive: true, force: true });
    if (guardError) throw guardError;
    const reason = error instanceof Error ? error.message : 'Repository operation failed.';
    throw new Error(`${reason} Only public repositories are cloned automatically. For a private repository, use gh auth status and gh repo clone manually, then read the local checkout; credentials are never passed here.`);
  } finally {
    clearInterval(timer);
    await checking;
    options.signal?.removeEventListener('abort', abort);
  }
}
