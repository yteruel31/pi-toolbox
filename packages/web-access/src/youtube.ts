import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdtemp, open, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { request, resolvePublic, publicAddress } from './network.js';
import { runProcess } from './process.js';

export const MAX_YOUTUBE_BYTES = 100 * 1024 * 1024;
const MAX_METADATA = 2 * 1024 * 1024;
const GUIDANCE = 'YouTube frames require Linux, system /usr Python3 and yt-dlp, bubblewrap, and enabled user/network namespaces. No unrestricted network fallback, cookies, transcripts, or paid APIs are supported.';

export function canonicalYouTubeUrl(input: string): string {
  const match = /^(?:https:\/\/(?:www\.)?youtube\.com\/watch\?v=|https:\/\/youtu\.be\/)([A-Za-z0-9_-]{11})$/.exec(input);
  if (!match || match[0] !== input) throw new Error('Only canonical HTTPS YouTube video URLs are supported.');
  return `https://www.youtube.com/watch?v=${match[1]}`;
}
const domain = (host: string, base: string) => host === base || host.endsWith(`.${base}`);

/** CONNECT authority grammar is deliberately stricter than URL parsing. */
export function youtubeProxyTarget(authority: string): URL {
  if (!/^[a-z0-9.-]+:443$/.test(authority)) throw new Error('Blocked proxy authority.');
  const host = authority.slice(0, -4);
  if (host.length > 253 || host.split('.').some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !(domain(host, 'youtube.com') || host === 'youtubei.googleapis.com' || domain(host, 'ytimg.com') || domain(host, 'googlevideo.com'))) {
    throw new Error('Blocked YouTube service domain.');
  }
  return new URL(`https://${host}/`);
}

export function youtubeMediaUrl(input: unknown): string {
  if (typeof input !== 'string' || input.length > 8192 || /[\s\\\x00-\x1f\x7f]/.test(input)) throw new Error('Missing, invalid or oversized media URL.');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !domain(url.hostname, 'googlevideo.com') || url.pathname !== '/videoplayback' ||
      url.searchParams.get('mime') !== 'video/mp4' || /manifest|\.m3u8|\.mpd/i.test(url.pathname)) {
    throw new Error('Only direct HTTPS googlevideo MP4 media is supported.');
  }
  return url.href;
}

export function parseYouTubeMetadata(text: string): { url: string; title: string } {
  if (Buffer.byteLength(text) > MAX_METADATA) throw new Error('YouTube metadata exceeds limit.');
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data._type && data._type !== 'video') ||
      data.ext !== 'mp4' || data.protocol !== 'https' || data.is_live === true || data.live_status === 'is_live' ||
      data.manifest_url || data.fragments || data.requested_formats || data.entries || data.vcodec === 'none') {
    throw new Error('Metadata is not a single direct MP4 video.');
  }
  for (const key of ['filesize', 'filesize_approx', 'duration']) {
    const value = data[key];
    if (value !== undefined && value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > (key === 'duration' ? 86400 : MAX_YOUTUBE_BYTES))) {
      throw new Error('YouTube size or duration exceeds safety limits.');
    }
  }
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 4096) throw new Error('Invalid YouTube title.');
  return { url: youtubeMediaUrl(data.url), title: data.title.replace(/[\x00-\x1f\x7f]/g, ' ') };
}

export interface YouTubeDependencies { bwrap: string; python: string; ytdlp: string }
export async function youtubeDependencies(platform: string = process.platform, exists: (path: string) => Promise<boolean> = async (path) => {
  try { await access(path, constants.X_OK); return true; } catch { return false; }
}): Promise<YouTubeDependencies> {
  if (platform !== 'linux') throw new Error(GUIDANCE);
  const find = async (paths: string[]) => { for (const path of paths) if (await exists(path)) return path; throw new Error(GUIDANCE); };
  return { bwrap: await find(['/usr/bin/bwrap', '/bin/bwrap']), python: await find(['/usr/bin/python3']), ytdlp: await find(['/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp']) };
}

/** Only a fresh private directory (bridge + socket) is shared with the child. */
export function youtubeIsolationPlan(deps: YouTubeDependencies, directory: string, url: string): { executable: string; args: string[] } {
  if (!['/usr/bin/bwrap', '/bin/bwrap'].includes(deps.bwrap) || deps.python !== '/usr/bin/python3' ||
      !['/usr/bin/yt-dlp', '/usr/local/bin/yt-dlp'].includes(deps.ytdlp) || !directory.startsWith('/') || directory === '/') throw new Error(GUIDANCE);
  return { executable: deps.bwrap, args: [
    '--unshare-user', '--unshare-pid', '--unshare-net', '--unshare-ipc', '--unshare-uts',
    '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--ro-bind-try', '/bin', '/bin',
    '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache', '--ro-bind-try', '/etc/ssl/certs', '/etc/ssl/certs',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/tmp/home',
    '--ro-bind', directory, '/bridge', '--chdir', '/tmp', '--clearenv',
    '--setenv', 'HOME', '/tmp/home', '--setenv', 'XDG_CONFIG_HOME', '/tmp/home',
    '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
    '--', deps.python, '-I', '/bridge/youtube-proxy.py', '/bridge/proxy.sock', deps.ytdlp, canonicalYouTubeUrl(url),
  ] };
}

export interface ProxyOptions {
  signal: AbortSignal;
  timeoutMs: number;
  resolve?: typeof resolvePublic;
  /** Must emit connect asynchronously, like net.connect; used for offline tests. */
  connect?: (address: { address: string; family: number }) => Duplex;
  maxConnections?: number;
  maxBytes?: number;
}

/** TLS remains end-to-end: the host proxy only checks/pins destinations and meters wire bytes. */
export async function startYouTubeProxy(path: string, options: ProxyOptions): Promise<{ close: () => Promise<void>; check: () => void }> {
  options.signal.throwIfAborted();
  for (const value of [options.timeoutMs, options.maxConnections ?? 50, options.maxBytes ?? 10 * 1024 * 1024]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error('Invalid YouTube proxy limits.');
  }
  const controller = new AbortController();
  const sockets = new Set<Duplex>();
  let failure: Error | undefined;
  let connections = 0, bytes = 0;
  const server = createServer({ maxHeaderSize: 8192 });
  const fail = (error: Error) => {
    failure ??= error;
    controller.abort(error);
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  const track = (socket: Duplex) => {
    sockets.add(socket);
    socket.on('error', () => fail(new Error('YouTube proxy connection failed.')));
    socket.once('close', () => sockets.delete(socket));
  };
  const meter = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > Math.min(options.maxBytes ?? 10 * 1024 * 1024, 10 * 1024 * 1024)) fail(new Error('YouTube proxy wire byte limit exceeded.'));
  };
  server.on('connection', (socket) => {
    track(socket);
    socket.on('data', meter); // Includes CONNECT headers and any pipelined TLS head exactly once.
    if (++connections > Math.min(options.maxConnections ?? 50, 50)) fail(new Error('YouTube proxy connection limit exceeded.'));
  });
  server.on('request', (_req, res) => { res.destroy(); fail(new Error('Only HTTPS CONNECT is allowed.')); });
  server.on('upgrade', (_req, socket) => { socket.destroy(); fail(new Error('Proxy upgrade refused.')); });
  server.on('clientError', () => fail(new Error('Invalid proxy request.')));
  server.on('connect', (req, client, head) => {
    client.pause();
    void (async () => {
      const target = youtubeProxyTarget(req.url ?? '');
      const address = await (options.resolve ?? resolvePublic)(target, controller.signal);
      controller.signal.throwIfAborted();
      if (!publicAddress(address.address) || ![4, 6].includes(address.family)) throw new Error('Blocked proxy address.');
      const upstream = (options.connect ?? ((entry) => netConnect({ host: entry.address, family: entry.family, port: 443 })))(address);
      track(upstream);
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.on('data', meter);
      upstream.once('connect', () => {
        if (controller.signal.aborted || client.destroyed) { upstream.destroy(); return; }
        const response = Buffer.from('HTTP/1.1 200 Connection Established\r\n\r\n');
        meter(response);
        if (controller.signal.aborted) return;
        client.write(response);
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client); client.resume();
      });
    })().catch((error: unknown) => fail(error instanceof Error ? error : new Error('Proxy failed.')));
  });
  const abort = () => fail(new Error('YouTube proxy aborted.'));
  options.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail(new Error('YouTube proxy timed out.')), options.timeoutMs);
  const close = async () => {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', abort);
    controller.abort();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  };
  try {
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(path, () => { server.removeListener('error', reject); server.on('error', fail); done(); });
    });
    await chmod(path, 0o600);
    if (options.signal.aborted) abort();
    if (failure) throw failure;
    return { close, check: () => { if (failure) throw failure; options.signal.throwIfAborted(); } };
  } catch (error) { await close(); throw error; }
}

/** No metadata-provided headers, cookies, redirects, or alternative sources are trusted. */
export async function downloadYouTubeMedia(url: string, options: { directory: string; timeoutMs: number; signal?: AbortSignal }, fetch: typeof request = request): Promise<string> {
  const source = youtubeMediaUrl(url);
  const result = await fetch(source, { signal: options.signal, timeoutMs: options.timeoutMs, maxBytes: MAX_YOUTUBE_BYTES, redirects: 0 });
  if (result.status !== 200 || youtubeMediaUrl(result.url) !== source || result.body.length > MAX_YOUTUBE_BYTES ||
      result.body.length < 12 || result.body.toString('ascii', 4, 8) !== 'ftyp' ||
      !/^video\/mp4(?:;|$)/i.test(result.headers['content-type'] ?? '')) throw new Error('YouTube media is not a bounded MP4 response.');
  options.signal?.throwIfAborted();
  const path = join(resolve(options.directory), `youtube-${randomUUID()}.mp4`);
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(result.body, { signal: options.signal });
    options.signal?.throwIfAborted();
    return path;
  } catch (error) { await rm(path, { force: true }); throw error; }
  finally { await file.close(); }
}

export async function downloadYouTube(url: string, options: { directory: string; timeoutMs: number; signal?: AbortSignal }): Promise<{ path: string; title: string }> {
  const canonical = canonicalYouTubeUrl(url);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647) throw new Error('Invalid YouTube timeout.');
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const deps = await youtubeDependencies();
  const directory = await mkdtemp(join(tmpdir(), 'web-youtube-'));
  let proxy: Awaited<ReturnType<typeof startYouTubeProxy>> | undefined;
  try {
    await chmod(directory, 0o700);
    await copyFile(new URL('./youtube-proxy.py', import.meta.url), join(directory, 'youtube-proxy.py'), constants.COPYFILE_EXCL);
    await chmod(join(directory, 'youtube-proxy.py'), 0o400);
    proxy = await startYouTubeProxy(join(directory, 'proxy.sock'), { signal, timeoutMs: options.timeoutMs });
    const plan = youtubeIsolationPlan(deps, directory, canonical);
    let output;
    try { output = await runProcess(plan.executable, plan.args, { timeoutMs: options.timeoutMs, signal, maxOutputBytes: MAX_METADATA }); }
    catch (error) { proxy.check(); throw new Error(`Isolated YouTube metadata extraction failed. ${GUIDANCE}`, { cause: error }); }
    proxy.check();
    await proxy.close();
    const metadata = parseYouTubeMetadata(output.stdout);
    const path = await downloadYouTubeMedia(metadata.url, { ...options, signal });
    return { path, title: metadata.title };
  } finally { await proxy?.close(); await rm(directory, { recursive: true, force: true }); }
}
