import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { runProcess } from './process.js';
import { downloadYouTube } from './youtube.js';
import { safeDirectory } from './store.js';

export interface VideoOptions {
  cwd: string; cacheDir: string; timeoutMs: number; signal?: AbortSignal;
  timestamp?: string; frames?: number;
}
export interface VideoResult {
  title: string; content: string; method: string;
  images: Array<{ data: string; mimeType: 'image/jpeg' }>;
}
const MAX_INPUT = 500 * 1024 * 1024;
const MAX_IMAGE = 2 * 1024 * 1024;
const MAX_IMAGES = 12 * 1024 * 1024;
const FORMATS = 'mov,matroska,webm,avi,flv,mpeg,mpegts,ogg';

export function isYouTubeVideo(input: string): boolean {
  return /^https:\/\/(?:www\.)?youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(input)
    || /^https:\/\/youtu\.be\/[A-Za-z0-9_-]{11}$/.test(input);
}

function seconds(value: string): number {
  if (!/^(?:\d+(?:\.\d+)?|\d+:[0-5]\d|\d+:[0-5]\d:[0-5]\d)$/.test(value)) throw new Error('Timestamp must be seconds, MM:SS or HH:MM:SS, optionally as a start-end range.');
  const parts = value.split(':').map(Number);
  const result = parts.reduce((total, part) => total * 60 + part, 0);
  if (!Number.isFinite(result) || result < 0 || result > 86400) throw new Error('Invalid timestamp.');
  return result;
}

/** Decode only local snapshots; YouTube metadata runs behind an isolated public-DNS-pinning proxy. */
export async function extractFrames(input: string, options: VideoOptions): Promise<VideoResult> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid video timeout.');
  const count = options.frames ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error('Frames must be an integer from 1 to 12.');
  const times = options.timestamp?.split('-').map(seconds);
  if (times && (times.length > 2 || (times.length === 2 && times[1]! <= times[0]!))) throw new Error('Invalid timestamp range.');
  if (isYouTubeVideo(input)) {
    await safeDirectory(options.cacheDir);
    const directory = await mkdtemp(join(resolve(options.cacheDir), 'youtube-'));
    const deadline = Date.now() + options.timeoutMs;
    try {
      const downloaded = await downloadYouTube(input, { directory, timeoutMs: options.timeoutMs, signal: options.signal });
      const result = await extractFrames(downloaded.path, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) });
      return { ...result, title: downloaded.title, method: 'youtube-local-frames', content: `YouTube: ${input}\n${result.content}` };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) || input.startsWith('//')) throw new Error('Only local video files or canonical YouTube URLs are supported.');
  const source = resolve(options.cwd, input);
  if (!/\.(?:mp4|mov|m4v|mkv|webm|avi|flv|mpeg|mpg|ts|ogv)$/i.test(source)) throw new Error('Unsupported video file type; playlists and SVG are not accepted.');
  const deadline = Date.now() + options.timeoutMs;
  const check = () => {
    if (options.signal?.aborted) throw new Error('Video extraction aborted.');
    if (Date.now() >= deadline) throw new Error('Video extraction timed out.');
  };
  check();
  const stat = await lstat(source);
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_INPUT) throw new Error('Video must be a regular file of at most 500 MiB (not a symlink).');
  await safeDirectory(options.cacheDir);
  const root = await mkdtemp(join(resolve(options.cacheDir), 'video-'));
  try {
    await chmod(root, 0o700);
    // Snapshot through O_NOFOLLOW; do not let a path replacement redirect the media reader.
    const file = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const snapshot = join(root, 'input');
    try {
      const current = await file.stat();
      if (!current.isFile() || current.size > MAX_INPUT) throw new Error('Invalid local video file.');
      const target = await open(snapshot, 'wx', 0o600);
      try {
        const buffer = Buffer.alloc(1024 * 1024);
        let total = 0;
        for (;;) {
          check();
          const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > MAX_INPUT) throw new Error('Video exceeds 500 MiB.');
          let written = 0;
          while (written < bytesRead) written += (await target.write(buffer, written, bytesRead - written)).bytesWritten;
        }
      } finally { await target.close(); }
    } finally { await file.close(); }
    const run = (executable: string, args: string[], maxOutputBytes = 256 * 1024) => {
      check();
      return runProcess(executable, args, { cwd: root, timeoutMs: Math.max(1, deadline - Date.now()), signal: options.signal, maxOutputBytes });
    };
    const restrictions = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS];
    const probe = await run('ffprobe', ['-v', 'error', ...restrictions, '-show_entries', 'format=duration,format_name:stream=codec_type,width,height,duration', '-of', 'json', snapshot]);
    let metadata: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> };
    try { metadata = JSON.parse(probe.stdout); } catch { throw new Error('Invalid video probe result.'); }
    const video = metadata?.streams?.find((stream) => stream.codec_type === 'video');
    const duration = Number(metadata?.format?.duration);
    const width = video?.width ?? 0, height = video?.height ?? 0;
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400 || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 64_000_000) {
      throw new Error('Video duration or dimensions are missing or exceed safety limits.');
    }
    const start = times?.[0] ?? 0;
    const end = times?.[1] ?? duration;
    if (start >= duration || end > duration) throw new Error('Timestamp is outside video duration.');
    const single = times?.length === 1;
    const actualCount = single ? 1 : count;
    const positions = Array.from({ length: actualCount }, (_, index) => single ? start : start + (end - start) * (index + 0.5) / actualCount);
    const images: VideoResult['images'] = [];
    let aggregate = 0;
    for (const [index, position] of positions.entries()) {
      const output = join(root, `frame-${index}.jpg`);
      await run('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', ...restrictions,
        '-ss', position.toFixed(3), '-i', snapshot, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
        '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease", '-threads', '1',
        '-c:v', 'mjpeg', '-q:v', '4', '-fs', String(MAX_IMAGE), '-f', 'image2', '-update', '1', output]);
      const size = await lstat(output);
      if (!size.isFile() || size.size > MAX_IMAGE || aggregate + size.size > MAX_IMAGES) throw new Error('Extracted image byte limit exceeded.');
      const data = await readFile(output);
      if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8 || data.at(-2) !== 0xff || data.at(-1) !== 0xd9) throw new Error('Invalid or truncated JPEG frame.');
      aggregate += data.length;
      images.push({ data: data.toString('base64'), mimeType: 'image/jpeg' });
    }
    check();
    return { title: basename(source), method: 'ffmpeg-local-frames', content: `Video: ${basename(source)}\nDuration: ${duration}s; dimensions: ${width}x${height}.\nFrames at ${positions.map((position) => `${position.toFixed(3)}s`).join(', ')}. No audio or transcript extracted.`, images };
  } finally { await rm(root, { recursive: true, force: true }); }
}
