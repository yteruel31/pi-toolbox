import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  /** Only sandbox-related Git variables are accepted. Never inherit the caller's environment. */
  env?: Record<string, string>;
}

export interface ProcessResult { stdout: string; stderr: string; }

const allowedEnvironment = new Set([
  'HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_LFS_SKIP_SMUDGE',
]);

/** Linux/POSIX process groups are required for descendant cleanup. Output is never included in errors. */
export async function runProcess(executable: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  if (process.platform === 'win32') throw new Error('Safe process-tree termination requires POSIX.');
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('Invalid process limits.');
  }
  if (options.signal?.aborted) throw new Error('Process aborted.');
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent', XDG_CONFIG_HOME: '/nonexistent' };
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (!allowedEnvironment.has(key)) throw new Error('Unsupported process environment variable.');
    env[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], { cwd: options.cwd, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let failure: Error | undefined;
    let bytes = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const killTree = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    };
    const fail = (message: string) => { failure ??= new Error(message); killTree(); };
    const abort = () => fail('Process aborted.');
    const timer = setTimeout(() => fail('Process timed out.'), options.timeoutMs);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const collect = (target: Buffer[]) => (data: Buffer) => {
      bytes += data.length;
      if (bytes > limit) fail('Process output limit exceeded.');
      else if (!failure) target.push(data);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(error.code === 'ENOENT' ? 'Required executable is not installed.' : 'Unable to start process.');
    });
    // Kill descendants even when their parent exits successfully or leaves inherited pipes open.
    child.on('exit', killTree);
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      killTree();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Process failed (exit ${code ?? 'signal'}).`));
      else resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    });
  });
}
