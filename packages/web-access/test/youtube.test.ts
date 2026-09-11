import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from 'node:net';
import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { canonicalYouTubeUrl, downloadYouTube, downloadYouTubeMedia, MAX_YOUTUBE_BYTES, parseYouTubeMetadata, startYouTubeProxy, youtubeDependencies, youtubeIsolationPlan, youtubeMediaUrl, youtubeProxyTarget } from '../src/youtube.js';
import type { ProxyOptions } from '../src/youtube.js';
import { resolvePublic } from '../src/network.js';

const video = 'https://www.youtube.com/watch?v=abcdefghijk';
const media = 'https://rr1---sn-test.googlevideo.com/videoplayback?mime=video%2Fmp4&sig=test';
const metadata = { title: 'Test video', url: media, ext: 'mp4', protocol: 'https', duration: 60, filesize: 1000 };

test('canonical videos only; no playlist, arbitrary source, credentials or URL parser normalization', () => {
  assert.equal(canonicalYouTubeUrl('https://youtu.be/abcdefghijk'), video);
  assert.equal(canonicalYouTubeUrl('https://youtube.com/watch?v=abcdefghijk'), video);
  for (const url of ['http://youtube.com/watch?v=abcdefghijk', video + '&list=abc', video + '#x', video + '\n', 'https://youtube.com.evil/watch?v=abcdefghijk', 'https://user@youtube.com/watch?v=abcdefghijk', 'https://localhost/watch?v=abcdefghijk', 'file:///tmp/a.mp4', 'https://youtube.com/shorts/abcdefghijk']) {
    assert.throws(() => canonicalYouTubeUrl(url), url);
  }
});

test('CONNECT allowlist is narrow and only allows explicit HTTPS port', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'youtubei.googleapis.com', 'i.ytimg.com', 'rr1.googlevideo.com']) assert.equal(youtubeProxyTarget(host + ':443').hostname, host);
  for (const authority of ['youtube.com:80', 'youtube.com', 'https://youtube.com:443', 'youtube.com:443/path', 'youtube.com:443@localhost', 'youtube.com.:443', 'youtube.com.evil:443', 'evilyoutube.com:443', 'googleapis.com:443', 'evil.googleapis.com:443', 'google.com:443', 'localhost:443', '127.0.0.1:443', '[::1]:443', 'a..youtube.com:443', '-a.youtube.com:443']) assert.throws(() => youtubeProxyTarget(authority), authority);
});

test('bounded direct MP4 metadata only', () => {
  assert.deepEqual(parseYouTubeMetadata(JSON.stringify(metadata)), { url: media, title: 'Test video' });
  for (const patch of [
    { ext: 'webm' }, { protocol: 'm3u8_native' }, { _type: 'playlist' }, { entries: [] },
    { fragments: [] }, { manifest_url: media }, { requested_formats: [] }, { vcodec: 'none' },
    { is_live: true }, { duration: 86401 }, { duration: -1 }, { duration: '10' },
    { filesize: MAX_YOUTUBE_BYTES + 1 }, { filesize_approx: MAX_YOUTUBE_BYTES + 1 }, { title: '' },
    { url: 'https://localhost/videoplayback?mime=video/mp4' },
  ]) assert.throws(() => parseYouTubeMetadata(JSON.stringify({ ...metadata, ...patch })));
  assert.throws(() => parseYouTubeMetadata(' '.repeat(2 * 1024 * 1024 + 1)));
  for (const url of [media.replace('https:', 'http:'), media.replace('.googlevideo.com', '.googlevideo.com.evil'), media.replace('/videoplayback', '/manifest.mpd'), media.replace('video%2Fmp4', 'audio%2Fmp4'), media.replace('https://', 'https://user:pass@'), media + '#fragment', media.replace('.com/', '.com:444/')]) assert.throws(() => youtubeMediaUrl(url));
});

test('launch plan denies host network/configs; dependencies fail closed', async () => {
  await assert.rejects(youtubeDependencies('darwin', async () => true), /require Linux/);
  await assert.rejects(youtubeDependencies('linux', async () => false), /bubblewrap/);
  const deps = await youtubeDependencies('linux', async () => true);
  const plan = youtubeIsolationPlan(deps, '/tmp/private-youtube', video);
  assert.equal(plan.executable, '/usr/bin/bwrap');
  for (const flag of ['--unshare-net', '--unshare-user', '--unshare-pid', '--clearenv', '--die-with-parent', '--cap-drop']) assert.ok(plan.args.includes(flag));
  const binds = plan.args.flatMap((arg, index) => ['--ro-bind', '--ro-bind-try'].includes(arg) ? [plan.args[index + 1]] : []);
  assert.deepEqual(binds, ['/usr', '/lib', '/lib64', '/bin', '/etc/ld.so.cache', '/etc/ssl/certs', '/tmp/private-youtube']);
  assert.ok(!plan.args.some((arg) => ['/home', '/run', '/etc', '--share-net', '--bind'].includes(arg)));
  assert.deepEqual(plan.args.slice(-6), ['/usr/bin/python3', '-I', '/bridge/youtube-proxy.py', '/bridge/proxy.sock', '/usr/bin/yt-dlp', video]);
  assert.throws(() => youtubeIsolationPlan({ ...deps, ytdlp: '/home/me/yt-dlp' }, '/tmp/private', video));
  await assert.rejects(downloadYouTube('https://evil.example/', { directory: '/tmp', timeoutMs: 100 }), /canonical/);
  await assert.rejects(downloadYouTube(video, { directory: '/tmp', timeoutMs: 0 }), /timeout/);
  const signal = AbortSignal.abort();
  await assert.rejects(downloadYouTube(video, { directory: '/tmp', timeoutMs: 100, signal }));
  const script = await readFile(new URL('../src/youtube-proxy.py', import.meta.url), 'utf8');
  for (const flag of ['--proxy', '--ignore-config', '--no-playlist', '--no-cache-dir', '--skip-download', '--dump-single-json', '--no-plugin-dirs', '--no-remote-components']) assert.ok(script.includes(flag));
  assert.ok(script.includes('shell=False'));
  assert.ok(!script.includes('os.environ'));
});

class FakeTransport extends Duplex {
  writes: Buffer[] = [];
  constructor() { super(); queueMicrotask(() => this.emit('connect')); }
  override _read() {}
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void) { this.writes.push(Buffer.from(chunk)); done(); }
}
async function fixture(overrides: Partial<ProxyOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'yt-proxy-test-'));
  const path = join(dir, 'proxy.sock');
  const controller = new AbortController();
  const transports: FakeTransport[] = [];
  const hosts: string[] = [];
  const proxy = await startYouTubeProxy(path, {
    signal: controller.signal, timeoutMs: 2000,
    resolve: async (url) => { hosts.push(url.hostname); return { address: '8.8.8.8', family: 4 }; },
    connect: (address) => { assert.deepEqual(address, { address: '8.8.8.8', family: 4 }); const transport = new FakeTransport(); transports.push(transport); return transport; },
    ...overrides,
  });
  return { path, proxy, controller, transports, hosts, cleanup: async () => { await proxy.close(); await rm(dir, { recursive: true, force: true }); } };
}
async function client(path: string) {
  const socket = connect(path);
  socket.on('error', () => {});
  await once(socket, 'connect');
  return socket;
}
const tick = () => new Promise((done) => setTimeout(done, 20));

test('offline proxy pins resolution and relays pipelined head plus TLS bytes', async () => {
  const f = await fixture();
  const socket = await client(f.path);
  try {
    const response = once(socket, 'data');
    socket.write('CONNECT www.youtube.com:443 HTTP/1.1\r\nHost: ignored.invalid\r\n\r\nTLS-head');
    assert.match((await response)[0].toString(), /200 Connection Established/);
    assert.deepEqual(f.hosts, ['www.youtube.com']);
    socket.write('TLS-more');
    await tick();
    assert.equal(Buffer.concat(f.transports[0]!.writes).toString(), 'TLS-headTLS-more');
    const reply = once(socket, 'data');
    f.transports[0]!.push(Buffer.from('TLS-reply'));
    assert.equal((await reply)[0].toString(), 'TLS-reply');
    f.proxy.check();
    f.controller.abort();
    await tick();
    assert.ok(f.transports[0]!.destroyed);
    assert.throws(f.proxy.check, /aborted/);
  } finally { socket.destroy(); await f.cleanup(); }
});

test('offline proxy refuses HTTP, upgrades, local hosts and private DNS before connect', async () => {
  for (const request of ['GET https://www.youtube.com/ HTTP/1.1\r\nHost: www.youtube.com\r\n\r\n', 'GET / HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n', 'CONNECT localhost:443 HTTP/1.1\r\n\r\n', 'CONNECT www.youtube.com:80 HTTP/1.1\r\n\r\n']) {
    const f = await fixture();
    const socket = await client(f.path);
    try { socket.write(request); await tick(); assert.throws(f.proxy.check); assert.equal(f.transports.length, 0); assert.equal(f.hosts.length, 0); }
    finally { socket.destroy(); await f.cleanup(); }
  }
  const f = await fixture({ resolve: async () => ({ address: '127.0.0.1', family: 4 }) });
  const socket = await client(f.path);
  try { socket.write('CONNECT www.youtube.com:443 HTTP/1.1\r\n\r\n'); await tick(); assert.throws(f.proxy.check, /Blocked proxy address/); assert.equal(f.transports.length, 0); }
  finally { socket.destroy(); await f.cleanup(); }
});

test('offline proxy caps total connections (not just concurrent connections)', async () => {
  const f = await fixture({ maxConnections: 1 });
  try {
    const first = await client(f.path); first.destroy(); await tick();
    const second = await client(f.path); await tick(); second.destroy();
    assert.throws(f.proxy.check, /connection limit/);
  } finally { await f.cleanup(); }
});

test('offline proxy meters both directions and closes on timeout', async () => {
  for (const direction of ['incoming', 'outgoing']) {
    const f = await fixture({ maxBytes: 200 });
    const socket = await client(f.path);
    try {
      const response = once(socket, 'data');
      socket.write('CONNECT www.youtube.com:443 HTTP/1.1\r\n\r\n'); await response;
      if (direction === 'incoming') socket.write(Buffer.alloc(300)); else f.transports[0]!.push(Buffer.alloc(300));
      await tick(); assert.throws(f.proxy.check, /wire byte limit/); assert.ok(f.transports[0]!.destroyed);
    } finally { socket.destroy(); await f.cleanup(); }
  }
  const f = await fixture({ timeoutMs: 30 });
  try { await new Promise((done) => setTimeout(done, 60)); assert.throws(f.proxy.check, /timed out/); }
  finally { await f.cleanup(); }
});

test('aggregate wire budget is shared across connections and directions', async () => {
  const f = await fixture({ maxBytes: 300 });
  const first = await client(f.path), second = await client(f.path);
  try {
    for (const socket of [first, second]) {
      const response = once(socket, 'data');
      socket.write('CONNECT www.youtube.com:443 HTTP/1.1\r\n\r\n'); await response;
    }
    first.write(Buffer.alloc(80)); await tick(); f.proxy.check();
    f.transports[1]!.push(Buffer.alloc(80)); await tick();
    assert.throws(f.proxy.check, /wire byte limit/);
    assert.ok(f.transports.every((transport) => transport.destroyed));
  } finally { first.destroy(); second.destroy(); await f.cleanup(); }
});

test('mixed public/private DNS answers are rejected before connecting', async () => {
  const f = await fixture({ resolve: (url, signal) => resolvePublic(url, signal, async () => [
    { address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 },
  ]) });
  const socket = await client(f.path);
  try {
    socket.write('CONNECT www.youtube.com:443 HTTP/1.1\r\n\r\n'); await tick();
    assert.throws(f.proxy.check, /DNS returned private/); assert.equal(f.transports.length, 0);
  } finally { socket.destroy(); await f.cleanup(); }
});

test('aborting pending DNS cannot create a late outbound socket', async () => {
  let resolve!: (value: { address: string; family: number }) => void;
  const pending = new Promise<{ address: string; family: number }>((done) => { resolve = done; });
  const f = await fixture({ resolve: async () => pending });
  const socket = await client(f.path);
  try {
    socket.write('CONNECT www.youtube.com:443 HTTP/1.1\r\n\r\n'); await tick();
    f.controller.abort(); resolve({ address: '8.8.8.8', family: 4 }); await tick();
    assert.equal(f.transports.length, 0); assert.throws(f.proxy.check, /aborted/);
  } finally { socket.destroy(); await f.cleanup(); }
});

test('parent media fetch forbids redirects/headers and writes private exclusive MP4', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yt-media-test-'));
  const body = Buffer.from('0000ftypisom0000');
  try {
    const path = await downloadYouTubeMedia(media, { directory, timeoutMs: 1000 }, async (url, options) => {
      assert.equal(url, media); assert.equal(options?.redirects, 0); assert.equal(options?.maxBytes, MAX_YOUTUBE_BYTES); assert.equal(options?.headers, undefined);
      return { url, status: 200, headers: { 'content-type': 'video/mp4' }, body };
    });
    assert.deepEqual(await readFile(path), body);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const patch of [{ status: 302 }, { url: 'https://localhost/a' }, { url: media + '&redirected=1' }, { body: Buffer.from('#EXTM3U') }, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }]) {
      await assert.rejects(downloadYouTubeMedia(media, { directory, timeoutMs: 1000 }, async () => ({ url: media, status: 200, headers: { 'content-type': 'video/mp4' }, body, ...patch })));
    }
    assert.equal((await readdir(directory)).length, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
